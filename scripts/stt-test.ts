// Round trip for the mic: VieNeu says a sentence → (16 kHz mono) → Qwen3-ASR transcribes it.
// Needs Mai's voice server running with the ASR model (restart Mai once after installing it).
// Usage: npx tsx scripts/stt-test.ts
import assert from "node:assert/strict";
import { loadConfig } from "../src/core/config.js";
import { ensureDirs } from "../src/core/paths.js";
import { vieneuVoiceFiles } from "../src/core/sidecars.js";
import { transcribeAudio } from "../src/core/stt.js";

ensureDirs();
const cfg = loadConfig();
const server = cfg.tts.vieneu.serverUrl.replace(/\/$/, "");

/** Same job as toWav16k() in the pet window, for a 16-bit PCM WAV: downmix + resample to 16 kHz mono. */
function toMono16k(wav: Buffer): Buffer {
	const ch = wav.readUInt16LE(22), rate = wav.readUInt32LE(24);
	let p = 12;
	while (wav.toString("ascii", p, p + 4) !== "data") p += 8 + wav.readUInt32LE(p + 4);
	const data = wav.subarray(p + 8, p + 8 + wav.readUInt32LE(p + 4));
	const frames = data.length / (2 * ch), outN = Math.floor((frames * 16000) / rate);
	const out = Buffer.alloc(44 + outN * 2);
	out.write("RIFF", 0); out.writeUInt32LE(36 + outN * 2, 4); out.write("WAVEfmt ", 8);
	out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(16000, 24);
	out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(outN * 2, 40);
	for (let i = 0; i < outN; i++) {
		const f = Math.min(frames - 1, Math.floor((i * rate) / 16000));
		let s = 0;
		for (let c = 0; c < ch; c++) s += data.readInt16LE((f * ch + c) * 2);
		out.writeInt16LE(Math.round(s / ch), 44 + i * 2);
	}
	return out;
}

async function say(text: string): Promise<Buffer> {
	const ph = await fetch(`http://127.0.0.1:${cfg.repair.needlePort}/phonemize`, { method: "POST", body: JSON.stringify({ text }) });
	const { phonemes } = (await ph.json()) as { phonemes: string };
	const r = await fetch(`${server}/v1/audio/speech`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "vieneu", input: phonemes, response_format: "wav", options: vieneuVoiceFiles(cfg.tts.vieneu.voice) }),
	});
	assert.ok(r.ok, `TTS HTTP ${r.status}`);
	return Buffer.from(await r.arrayBuffer());
}

const words = (s: string) => s.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
for (const [text, lang] of [
	["Chị ơi, hôm nay em mệt quá, nhắc em đi ngủ sớm nhé.", "vi"],
	["Remind me to call my mom tomorrow at eight.", "en"],
] as const) {
	const t0 = Date.now();
	const heard = await transcribeAudio(toMono16k(await say(text)), cfg, { lang });
	const want = words(text), got = new Set(words(heard));
	const hit = want.filter((w) => got.has(w)).length / want.length;
	console.log(`${hit >= 0.7 ? "✓" : "✗"} [${lang}] ${Math.round(hit * 100)}% words, ${Date.now() - t0} ms\n    said:  ${text}\n    heard: ${heard}`);
	assert.ok(hit >= 0.7, "transcript too different");
}
console.log("speech recognition round trip passed");
