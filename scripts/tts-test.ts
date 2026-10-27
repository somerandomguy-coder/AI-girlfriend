// Synthesize a few lines with the configured voice and save them as files you can play.
// Usage: npx tsx scripts/tts-test.ts [voice-id]      (needs the Python sidecar + audio.cpp server running for vieneu)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.js";
import { ensureDirs, paths } from "../src/core/paths.js";
import { Speaker } from "../src/core/tts.js";

ensureDirs();
const cfg = loadConfig();
if (process.argv[2]) cfg.tts.vieneu.voice = process.argv[2];
const speaker = new Speaker(cfg);
speaker.onFallback = (reason) => console.log(`  ! VieNeu unavailable, fell back to edge: ${reason}`);

const out = join(paths.state, "tts-test");
mkdirSync(out, { recursive: true });
const lines = [
	"Em ăn cơm chưa? Đừng có nói dối chị.",
	"Đi ngủ đi nhóc, 2 giờ sáng rồi đấy!",
	"Good boy. Now drink some water, and then we'll talk about that interview on Friday.",
];
console.log(`engine=${cfg.tts.engine} voice=${cfg.tts.vieneu.voice}`);
for (const [i, line] of lines.entries()) {
	const t0 = Date.now();
	const s = await speaker.synthesize(line, "stern");
	if (!s) continue;
	const file = join(out, `line${i + 1}.${s.mime.includes("wav") ? "wav" : "mp3"}`);
	writeFileSync(file, s.audio);
	console.log(`  ${Date.now() - t0} ms  ${(s.audio.length / 1024).toFixed(0)} KB  ${s.mime}  ${file}`);
}
