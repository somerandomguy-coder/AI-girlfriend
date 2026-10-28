import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "./paths.js";

export interface Config {
	/** What she calls the user until she learns better. */
	userName: string;
	ollama: {
		baseUrl: string;
		/** Main brain: chat + tools + vision. */
		model: string;
		/**
		 * Goal-check judge: an Ollama decision model (needs Ollama 0.40.4+). Empty, missing or failing → her
		 * own model judges instead, slower, so only on replies that look like claims or unfinished work.
		 */
		judgeModel: string;
		contextWindow: number;
		/** Let the model think before answering. Smarter, but several times slower on local GPUs. */
		think: boolean;
	};
	heartbeat: {
		enabled: boolean;
		/** How often she reconsiders whether to say something. */
		intervalMinutes: number;
		/** Hard cap on unprompted messages per day. */
		maxProactivePerDay: number;
		/** Local hours (0-23) when she stays quiet unless something is due. */
		quietHours: { start: number; end: number };
		/** Chance per eligible tick that she asks a random question / starts a bit. */
		spontaneity: number;
	};
	screen: {
		/** Poll the foreground window title (cheap, local). */
		watchWindows: boolean;
		/** Allow occasional screenshots sent to the local vision model. */
		allowScreenshots: boolean;
		/** Window titles/processes that are never looked at or mentioned. */
		blocklist: string[];
	};
	quests: { enabled: boolean; maxActive: number };
	tts: {
		/**
		 * vieneu = VieNeu-TTS v3 Turbo through a local audio.cpp server (offline, vi+en; falls back to edge if down);
		 * edge = Microsoft neural voices (online, zero VRAM); openai = any other /v1/audio/speech server; none.
		 */
		engine: "voxcpm2" | "vieneu" | "edge" | "openai" | "none";
		voiceEn: string;
		voiceVi: string;
		rate: string;
		vieneu: {
			serverUrl: string;
			/** Preset voice id under sidecars/audiocpp/models/vieneu/voices. */
			voice: string;
			/** Start audiocpp_server with the app when it isn't already running. */
			autostart: boolean;
			/** cpu keeps all VRAM for the LLM; cuda needs the CUDA build of audio.cpp. */
			backend: "cpu" | "cuda";
			threads: number;
		};
		/** Expressive engine for big GPUs (~3 GB VRAM): per-mood style prompts, clones Mai's reference clip. */
		voxcpm2: {
			/** Optional WAV (5–10 s, one speaker) to be Mai's voice; default: a clip VieNeu makes once. */
			voiceRef: string;
		};
		openai: { baseUrl: string; model: string; voice: string };
	};
	repair: {
		/** Use the needle sidecar when an LLM tool call can't be fixed with plain JSON repair. */
		useNeedle: boolean;
		/** Port of the Python sidecar (needle repair + VieNeu phonemizer). */
		needlePort: number;
	};
	agent: {
		/** Extra nudges when she stops mid-task ("CONTINUE" verdict from the goal check). */
		maxAutoContinues: number;
		/** Work mode budget for one approved long task. */
		longTask: { maxTurns: number; maxMinutes: number };
	};
	shell: {
		/** Let her run PowerShell. Dangerous commands are always blocked regardless. */
		enabled: boolean;
		/** writes = read-only commands run freely, anything else asks him; always = ask for every command. */
		approval: "writes" | "always";
		timeoutSeconds: number;
	};
	/** Folders she may move/inspect files in for side quests and file chores. */
	allowedRoots: string[];
	spriteSet: string;
	pet: {
		/** Let her stroll along the taskbar in roam mode. */
		wander: boolean;
		/** roam = small, living on the desktop; chat = full window. */
		startIn: "roam" | "chat";
	};
}

const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";

export const DEFAULT_CONFIG: Config = {
	userName: "you",
	ollama: {
		baseUrl: "http://127.0.0.1:11434",
		model: "mai-brain",
		judgeModel: "tev1:4b-q4_K_M",
		contextWindow: 16384,
		think: false,
	},
	heartbeat: {
		enabled: true,
		intervalMinutes: 20,
		maxProactivePerDay: 12,
		quietHours: { start: 1, end: 8 },
		spontaneity: 0.35,
	},
	screen: {
		watchWindows: true,
		allowScreenshots: false,
		blocklist: ["1password", "bitwarden", "keepass", "bank", "inprivate", "incognito", "password", "windows security"],
	},
	quests: { enabled: true, maxActive: 2 },
	tts: {
		engine: "vieneu",
		voiceEn: "en-US-AvaMultilingualNeural",
		voiceVi: "vi-VN-HoaiMyNeural",
		rate: "+0%",
		vieneu: { serverUrl: "http://127.0.0.1:8080", voice: "truc_ly", autostart: true, backend: "cpu", threads: 6 },
		voxcpm2: { voiceRef: "" },
		openai: { baseUrl: "http://127.0.0.1:8080", model: "vieneu-tts", voice: "default" },
	},
	repair: { useNeedle: true, needlePort: 8765 },
	agent: { maxAutoContinues: 3, longTask: { maxTurns: 150, maxMinutes: 90 } },
	shell: { enabled: true, approval: "writes", timeoutSeconds: 60 },
	allowedRoots: [`${home}\\Desktop`, `${home}\\Documents`, `${home}\\Downloads`, `${home}\\Pictures`],
	spriteSet: "aza",
	pet: { wander: true, startIn: "roam" },
};

function merge<T>(base: T, over: unknown): T {
	if (typeof base !== "object" || base === null || Array.isArray(base)) return (over ?? base) as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	if (over && typeof over === "object") {
		for (const [k, v] of Object.entries(over)) out[k] = k in out ? merge(out[k], v) : v;
	}
	return out as T;
}

export function loadConfig(): Config {
	if (!existsSync(paths.config)) {
		writeFileSync(paths.config, JSON.stringify(DEFAULT_CONFIG, null, 2));
		return structuredClone(DEFAULT_CONFIG);
	}
	const cfg = merge(DEFAULT_CONFIG, JSON.parse(readFileSync(paths.config, "utf8").replace(/^FEFF/, "")));
	return cfg;
}

export function saveConfig(cfg: Config): void {
	writeFileSync(paths.config, JSON.stringify(cfg, null, 2));
}
