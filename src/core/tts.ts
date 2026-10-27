import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import type { Config } from "./config.js";
import type { Mood } from "./mood.js";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";
import { vieneuVoiceFiles } from "./sidecars.js";

/** Vietnamese if a meaningful share of letters carry Vietnamese-specific diacritics. */
export function detectLang(text: string): "vi" | "en" {
	const vi = text.match(/[ăâđêôơưàảãáạằẳẵắặầẩẫấậèẻẽéẹềểễếệìỉĩíịòỏõóọồổỗốộờởỡớợùủũúụừửữứựỳỷỹýỵ]/gi)?.length ?? 0;
	const letters = text.match(/\p{L}/gu)?.length ?? 1;
	return vi / letters > 0.04 ? "vi" : "en";
}

/** Strip things that sound bad when read aloud. */
export function speakable(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\[[a-z]+\]/gi, "")
		.replace(/[*_#>|]/g, "")
		.replace(/https?:\/\/\S+/g, "link")
		.replace(/\p{Extended_Pictographic}/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

const PROSODY: Record<Mood, { rate: string; pitch: string }> = {
	neutral: { rate: "+0%", pitch: "+0%" },
	happy: { rate: "+6%", pitch: "+6%" },
	proud: { rate: "+3%", pitch: "+4%" },
	teasing: { rate: "+4%", pitch: "+3%" },
	stern: { rate: "-6%", pitch: "-6%" },
	angry: { rate: "+4%", pitch: "-4%" },
	pouty: { rate: "-4%", pitch: "+5%" },
	worried: { rate: "-5%", pitch: "+2%" },
	sleepy: { rate: "-12%", pitch: "-4%" },
};

/**
 * VieNeu has no emotion control, but hotter sampling varies the intonation (upstream: "higher values add
 * expressiveness but can be less stable") and it understands three non-verbal cues: laugh, sigh, ahem.
 */
const VIENEU_MOOD: Record<Mood, { temperature: number; topK: number; before?: string; after?: string }> = {
	neutral: { temperature: 0.85, topK: 30 },
	happy: { temperature: 0.92, topK: 40, after: "cười" },
	proud: { temperature: 0.9, topK: 40, after: "cười" },
	teasing: { temperature: 0.92, topK: 40, after: "cười" },
	stern: { temperature: 0.8, topK: 25, before: "hắng giọng" },
	angry: { temperature: 0.95, topK: 40 },
	pouty: { temperature: 0.85, topK: 30, before: "thở dài" },
	worried: { temperature: 0.82, topK: 30, before: "thở dài" },
	sleepy: { temperature: 0.75, topK: 25, before: "thở dài" },
};

/** VoxCPM2 style prefixes (English descriptions work for Vietnamese text too). */
const VOX_STYLE: Record<Mood, string> = {
	neutral: "young woman, natural calm conversational tone",
	happy: "young woman, cheerful and bright, smiling, lively",
	proud: "young woman, confident and proud, warm, emphatic",
	teasing: "young woman, playful teasing tone, sly smile, slightly faster",
	stern: "young woman, firm and serious, bossy, slower",
	angry: "young woman, annoyed and angry, sharp, forceful",
	pouty: "young woman, sulky pouting tone, whiny",
	worried: "young woman, worried and caring, soft, gentle, hesitant",
	sleepy: "young woman, sleepy and drowsy, soft, slow",
};

export interface SpeechAudio {
	audio: Buffer;
	mime: string;
	lang: "vi" | "en";
}

/**
 * Pluggable TTS:
 *  - vieneu: VieNeu-TTS v3 Turbo on a local audio.cpp server, fully offline, one voice for vi+en.
 *    Text → SEA-G2P phonemes (Python sidecar) → audio.cpp. Falls back to edge when either is down.
 *  - edge: Microsoft neural voices, free, online, zero VRAM.
 *  - openai: any other OpenAI-style /v1/audio/speech server.
 */
export class Speaker {
	/** Called once when VieNeu fails and speech falls back to edge (cleared on the next success). */
	onFallback?: (reason: string) => void;
	private fellBack = false;

	constructor(private readonly cfg: Config) {}

	async synthesize(rawText: string, mood: Mood = "neutral"): Promise<SpeechAudio | null> {
		const text = speakable(rawText);
		if (!text || this.cfg.tts.engine === "none") return null;
		const lang = detectLang(text);
		if (this.cfg.tts.engine === "openai") return this.openai(text, lang);
		// Expressive → steady → online: each local engine falls back to the next one.
		const chain: Array<() => Promise<SpeechAudio>> = [];
		if (this.cfg.tts.engine === "voxcpm2") chain.push(() => this.voxcpm2(text, lang, mood));
		if (this.cfg.tts.engine === "voxcpm2" || this.cfg.tts.engine === "vieneu") chain.push(() => this.vieneu(text, lang, mood));
		for (const attempt of chain) {
			try {
				const out = await attempt();
				this.fellBack = false;
				return out;
			} catch (e) {
				if (!this.fellBack) this.onFallback?.((e as Error).message);
				this.fellBack = true;
			}
		}
		return this.edge(text, lang, mood);
	}

	private get server(): string {
		return this.cfg.tts.vieneu.serverUrl.replace(/\/$/, "");
	}

	private async speech(body: Record<string, unknown>, timeoutMs: number): Promise<Buffer> {
		const res = await fetch(`${this.server}/v1/audio/speech`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ response_format: "wav", ...body }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) throw new Error(`audio.cpp HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
		return Buffer.from(await res.arrayBuffer());
	}

	/**
	 * VoxCPM2 takes a free-text style prefix — "(young woman, playful teasing tone)…" — which is the only
	 * open Vietnamese-capable emotion control we found. It clones Mai's reference clip so the voice stays
	 * the same person across moods; the clip is made once by VieNeu if the user hasn't supplied one.
	 */
	private async voxcpm2(text: string, lang: "vi" | "en", mood: Mood): Promise<SpeechAudio> {
		const ref = await this.referenceClip();
		const audio = await this.speech({ model: "voxcpm2", input: `(${VOX_STYLE[mood]})${text}`, voice_ref: ref }, 120_000);
		return { audio, mime: "audio/wav", lang };
	}

	private async referenceClip(): Promise<string> {
		const custom = this.cfg.tts.voxcpm2.voiceRef;
		if (custom && existsSync(custom)) return custom.replace(/\\/g, "/");
		const file = join(paths.state, `mai-voice-${this.cfg.tts.vieneu.voice}.wav`);
		if (!existsSync(file)) {
			const clip = await this.vieneu("Chào em, chị là Mai. Hôm nay em thế nào rồi? Nhớ ăn uống đầy đủ nhé.", "vi", "neutral");
			writeFileSync(file, clip.audio);
		}
		return file.replace(/\\/g, "/");
	}

	private async vieneu(text: string, lang: "vi" | "en", mood: Mood): Promise<SpeechAudio> {
		const tune = VIENEU_MOOD[mood];
		// A sigh before a pouty line, a little laugh after a teasing one: sometimes, not every sentence.
		const cued = `${tune.before && Math.random() < 0.4 ? `[${tune.before}] ` : ""}${text}${tune.after && Math.random() < 0.35 ? ` [${tune.after}]` : ""}`;
		const ph = await fetch(`http://127.0.0.1:${this.cfg.repair.needlePort}/phonemize`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: cued }),
			signal: AbortSignal.timeout(10_000),
		});
		if (!ph.ok) throw new Error(`phonemizer HTTP ${ph.status}: ${(await ph.text()).slice(0, 200)}`);
		const { phonemes } = (await ph.json()) as { phonemes: string };
		const audio = await this.speech(
			{
				model: "vieneu",
				input: phonemes,
				options: { ...vieneuVoiceFiles(this.cfg.tts.vieneu.voice), temperature: tune.temperature, top_k: tune.topK },
			},
			90_000,
		);
		return { audio, mime: "audio/wav", lang };
	}

	private async edge(text: string, lang: "vi" | "en", mood: Mood): Promise<SpeechAudio> {
		const tts = new MsEdgeTTS();
		await tts.setMetadata(lang === "vi" ? this.cfg.tts.voiceVi : this.cfg.tts.voiceEn, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
		const { audioStream, metadataStream } = tts.toStream(text, PROSODY[mood]);
		// msedge-tts can destroy() its streams with an error after they ended (socket closing late);
		// with no listener left that becomes an uncaught exception, so keep handlers attached for life.
		metadataStream?.on("error", () => {});
		const chunks: Buffer[] = [];
		try {
			await new Promise<void>((resolve, reject) => {
				audioStream.on("data", (c: Buffer) => chunks.push(c));
				audioStream.on("end", () => resolve());
				audioStream.on("error", reject);
			});
		} finally {
			audioStream.on("error", () => {});
			try {
				tts.close();
			} catch {
				/* already closed */
			}
		}
		return { audio: Buffer.concat(chunks), mime: "audio/mpeg", lang };
	}

	private async openai(text: string, lang: "vi" | "en"): Promise<SpeechAudio> {
		const o = this.cfg.tts.openai;
		const res = await fetch(`${o.baseUrl.replace(/\/$/, "")}/v1/audio/speech`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: o.model, voice: o.voice, input: text, language: lang, response_format: "wav" }),
			signal: AbortSignal.timeout(60_000),
		});
		if (!res.ok) throw new Error(`TTS server HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
		return { audio: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? "audio/wav", lang };
	}
}
