import type { Config } from "./config.js";

export interface TranscribeOptions {
	lang?: "vi" | "en" | "auto";
	prompt?: string;
}

/**
 * Transcribes audio data to text with priority for Vietnamese and English.
 * 1. Tries OpenAI-compatible /v1/audio/transcriptions on the local audio.cpp server (port 8080).
 * 2. Tries configured OpenAI Whisper endpoint if available.
 * 3. Tries Python sidecar /transcribe endpoint.
 */
export async function transcribeAudio(
	audioBuffer: Buffer,
	mimeType: string,
	cfg: Config,
	opts?: TranscribeOptions,
): Promise<string> {
	const lang = opts?.lang ?? "vi";

	// 1. Try local audio server (audio.cpp or local whisper server on 8080)
	const serverUrl = cfg.tts.vieneu.serverUrl.replace(/\/$/, "");
	try {
		const formData = new FormData();
		const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("wav") ? "wav" : "ogg";
		const blob = new Blob([audioBuffer as any], { type: mimeType });
		formData.append("file", blob, `voice.${ext}`);
		formData.append("model", "whisper");
		formData.append("language", lang === "vi" ? "vi" : "en");

		const res = await fetch(`${serverUrl}/v1/audio/transcriptions`, {
			method: "POST",
			body: formData,
			signal: AbortSignal.timeout(12000),
		});
		if (res.ok) {
			const data = (await res.json()) as { text?: string };
			if (data.text?.trim()) return data.text.trim();
		}
	} catch {
		// Local endpoint not responding to transcription
	}

	// 2. Try configured OpenAI-compatible STT endpoint if specified
	if (cfg.tts.openai.baseUrl && cfg.tts.openai.baseUrl !== serverUrl) {
		try {
			const formData = new FormData();
			const blob = new Blob([audioBuffer as any], { type: mimeType });
			formData.append("file", blob, "voice.wav");
			formData.append("model", "whisper-1");
			formData.append("language", lang === "vi" ? "vi" : "en");

			const res = await fetch(`${cfg.tts.openai.baseUrl.replace(/\/$/, "")}/v1/audio/transcriptions`, {
				method: "POST",
				body: formData,
				signal: AbortSignal.timeout(15000),
			});
			if (res.ok) {
				const data = (await res.json()) as { text?: string };
				if (data.text?.trim()) return data.text.trim();
			}
		} catch {}
	}

	// 3. Try Python sidecar endpoint
	try {
		const res = await fetch(`http://127.0.0.1:${cfg.repair.needlePort}/transcribe`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				audio: audioBuffer.toString("base64"),
				mimeType,
				lang,
			}),
			signal: AbortSignal.timeout(12000),
		});
		if (res.ok) {
			const data = (await res.json()) as { text?: string };
			if (data.text?.trim()) return data.text.trim();
		}
	} catch {}

	return "";
}
