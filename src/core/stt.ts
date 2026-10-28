import { existsSync } from "node:fs";
import type { Config } from "./config.js";
import { ASR_MODEL, ASR_MODEL_ID } from "./sidecars.js";

export interface TranscribeOptions {
	/** Recognition language hint; "auto" lets the model decide (good for mixed Vietnamese/English). */
	lang?: "vi" | "en" | "auto";
}

const LANGUAGE_NAME = { vi: "Vietnamese", en: "English" } as const;

/**
 * Speech → text for the 🎙️ button, using Qwen3-ASR on the local audio.cpp server.
 * The pet window converts the recording to 16 kHz mono WAV first: that is the only format the server's
 * transcription route accepts. Errors are thrown (not swallowed) so the bubble can say what went wrong.
 */
export async function transcribeAudio(wav: Buffer, cfg: Config, opts: TranscribeOptions = {}): Promise<string> {
	if (!existsSync(ASR_MODEL)) {
		throw new Error("Speech recognition isn't installed yet. Run setup.cmd (or scripts\\setup-vieneu.ps1) once.");
	}
	if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") throw new Error("Recording isn't a WAV file.");
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");
	form.append("model", ASR_MODEL_ID);
	const lang = opts.lang ?? "auto";
	if (lang !== "auto") form.append("language", LANGUAGE_NAME[lang]);

	const server = cfg.tts.vieneu.serverUrl.replace(/\/$/, "");
	let res: Response;
	try {
		// The first request loads the model (~1–3 s); later ones are fast.
		res = await fetch(`${server}/v1/audio/transcriptions`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
	} catch (e) {
		throw new Error(`The voice server at ${server} isn't answering (${(e as Error).message}). Is Mai's voice server running?`);
	}
	if (!res.ok) throw new Error(`Speech recognition failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
	const data = (await res.json()) as { text?: string };
	return (data.text ?? "").trim();
}
