import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { APP_ROOT, paths } from "./paths.js";

const AUDIOCPP = join(APP_ROOT, "sidecars", "audiocpp");
const VIENEU = join(AUDIOCPP, "models", "vieneu");
const VOXCPM2 = join(AUDIOCPP, "models", "voxcpm2", "voxcpm2-q8_0.gguf");
/** Speech recognition for the 🎙️ button: Qwen3-ASR-0.6B (Vietnamese + English, 30 languages). */
export const ASR_MODEL = join(AUDIOCPP, "models", "qwen3-asr", "qwen3-asr-0.6b-q8_0.gguf");
export const ASR_MODEL_ID = "qwen3-asr";
const toPosix = (p: string) => p.replace(/\\/g, "/");

export interface VoiceInfo {
	id: string;
	label: string;
}

/** Preset VieNeu voices that are actually downloaded, labelled from the model's manifest. */
export function vieneuVoices(): VoiceInfo[] {
	const dir = join(VIENEU, "voices");
	if (!existsSync(dir)) return [];
	let labels: Record<string, string> = {};
	try {
		const m = JSON.parse(readFileSync(join(VIENEU, "manifest.json"), "utf8")) as { voices: Array<{ id: string; label: string }> };
		labels = Object.fromEntries(m.voices.map((v) => [v.id, v.label]));
	} catch {
		/* labels are cosmetic */
	}
	return readdirSync(dir)
		.filter((id) => existsSync(join(dir, id, "ref_codes.txt")) && existsSync(join(dir, id, "speaker.emb.txt")))
		.map((id) => ({ id, label: labels[id] ?? id }));
}

export function vieneuVoiceFiles(id: string): { reference_codes_file: string; speaker_embedding_file: string } {
	const dir = join(VIENEU, "voices", id);
	if (!existsSync(join(dir, "ref_codes.txt"))) throw new Error(`VieNeu voice "${id}" is not downloaded`);
	return { reference_codes_file: toPosix(join(dir, "ref_codes.txt")), speaker_embedding_file: toPosix(join(dir, "speaker.emb.txt")) };
}

async function up(url: string): Promise<boolean> {
	try {
		return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok;
	} catch {
		return false;
	}
}

/**
 * Helper processes Mai owns: the Python sidecar (needle repair + phonemizer) and the audio.cpp
 * TTS server. Only processes started here are stopped on exit; a server the user already runs is reused.
 */
export class Sidecars {
	private python?: ChildProcess;
	private audio?: ChildProcess;
	private audioStartedByUs = false;
	notes: string[] = [];

	constructor(private readonly cfg: Config) {}

	get pythonRunning(): boolean {
		return !!this.python && this.python.exitCode === null;
	}

	async start(): Promise<void> {
		const vieneu = this.cfg.tts.engine === "vieneu" || this.cfg.tts.engine === "voxcpm2";
		if (this.cfg.repair.useNeedle || vieneu) this.startPython();
		// The same server also does speech recognition, so start it if either the voice or the mic needs it.
		if ((vieneu || existsSync(ASR_MODEL)) && this.cfg.tts.vieneu.autostart) await this.startAudio();
	}

	private startPython(): void {
		const py = join(paths.needleSidecar, ".venv", "Scripts", "python.exe");
		if (!existsSync(py)) {
			this.notes.push("Python sidecar venv missing: tool-call repair uses JSON repair only, and VieNeu voice falls back to edge.");
			return;
		}
		this.python = spawn(py, ["-I", join(paths.needleSidecar, "server.py"), String(this.cfg.repair.needlePort)], { windowsHide: true, stdio: "ignore" });
	}

	/** audio.cpp config with absolute paths, regenerated each start so backend/threads/voice settings apply. */
	private writeServerConfig(): string {
		const url = new URL(this.cfg.tts.vieneu.serverUrl);
		const voice = vieneuVoiceFiles(this.cfg.tts.vieneu.voice);
		const file = join(paths.state, "audiocpp-server.json");
		writeFileSync(
			file,
			JSON.stringify(
				{
					host: url.hostname,
					port: Number(url.port || 8080),
					backend: this.cfg.tts.vieneu.backend,
					device: 0,
					threads: this.cfg.tts.vieneu.threads,
					lazy_load: true,
					// Voice + mic are both small (~0.2 + ~1.2 GB): keep both resident, or every spoken turn
					// would unload one to load the other.
					max_loaded_models: existsSync(ASR_MODEL) ? 2 : 1,
					ui: true,
					ui_management: false,
					models: [
						{
							id: "vieneu",
							family: "vieneu_v3_turbo",
							path: toPosix(join(VIENEU, "vieneu-v3-turbo-q8_0.gguf")),
							task: "tts",
							mode: "offline",
							default_request_options: voice,
						},
						...(this.cfg.tts.engine === "voxcpm2" && existsSync(VOXCPM2)
							? [{ id: "voxcpm2", family: "voxcpm2", path: toPosix(VOXCPM2), task: "tts", mode: "offline", lazy: true }]
							: []),
						...(existsSync(ASR_MODEL)
							? [{ id: ASR_MODEL_ID, family: "qwen3_asr", path: toPosix(ASR_MODEL), task: "asr", mode: "offline", lazy: true }]
							: []),
					],
				},
				null,
				2,
			),
		);
		return file;
	}

	private async startAudio(): Promise<void> {
		const base = this.cfg.tts.vieneu.serverUrl.replace(/\/$/, "");
		if (await up(`${base}/health`)) return; // already running (started by the user or a previous Mai)
		const exe = join(AUDIOCPP, "bin", "audiocpp_server.exe");
		if (!existsSync(exe) || !existsSync(join(VIENEU, "vieneu-v3-turbo-q8_0.gguf"))) {
			this.notes.push("audio.cpp or the VieNeu model is missing (run scripts/setup-vieneu.ps1); using the edge voice.");
			return;
		}
		const config = this.writeServerConfig();
		this.audioStartedByUs = true;
		this.audio = spawn(exe, ["--config", config, "--log", "--log-file", join(paths.state, "audiocpp-server.log")], {
			cwd: join(AUDIOCPP, "bin"),
			windowsHide: true,
			stdio: "ignore",
		});
		void this.warmUp(base);
	}

	/** The first synthesis builds large caches; do it now so her first real sentence isn't the slow one. */
	private async warmUp(base: string): Promise<void> {
		for (let i = 0; i < 60 && !(await up(`${base}/health`)); i++) await new Promise((r) => setTimeout(r, 1000));
		try {
			await fetch(`${base}/v1/audio/speech`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				// "Xin chào." as SEA-G2P phonemes, so the warm-up doesn't depend on the Python sidecar.
				body: JSON.stringify({ model: "vieneu", input: "sˈin tʃˈaː2w.", response_format: "wav" }),
				signal: AbortSignal.timeout(120_000),
			});
		} catch {
			/* best effort */
		}
	}

	static killAllAudioServers(): void {
		if (process.platform === "win32") {
			try {
				execFile("taskkill.exe", ["/F", "/IM", "audiocpp_server.exe", "/T"], { windowsHide: true }, () => {});
				execFile("taskkill.exe", ["/F", "/IM", "llama-server.exe", "/T"], { windowsHide: true }, () => {});
			} catch {}
		}
	}

	dispose(): void {
		if (this.python?.pid) {
			if (process.platform === "win32") {
				try {
					execFile("taskkill.exe", ["/pid", String(this.python.pid), "/T", "/F"], { windowsHide: true }, () => {});
				} catch {}
			} else {
				this.python.kill();
			}
		}
		if (this.audio?.pid) {
			if (process.platform === "win32") {
				try {
					execFile("taskkill.exe", ["/pid", String(this.audio.pid), "/T", "/F"], { windowsHide: true }, () => {});
				} catch {}
			} else {
				this.audio.kill();
			}
		}
		if (this.audioStartedByUs) {
			Sidecars.killAllAudioServers();
		}
	}
}
