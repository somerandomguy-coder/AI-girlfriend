// Shows when each sentence is handed to the voice vs when the full reply finishes.
// Usage: MAI_HOME=<scratch> npx tsx scripts/utterance-timing.ts
import { Brain, type BrainEvent } from "../src/core/brain.js";
const brain = new Brain();
brain.cfg.tts.vieneu.autostart = false;
brain.cfg.heartbeat.enabled = false;
await brain.start();
let t0 = 0;
brain.on("event", (e: BrainEvent) => {
	const t = ((Date.now() - t0) / 1000).toFixed(1);
	if (e.type === "utterance") console.log(`${t}s  voice ← ${e.text}`);
	if (e.type === "say") console.log(`${t}s  full reply done (${e.text.length} chars)`);
});
t0 = Date.now();
await brain.chat("Kể cho em nghe 4 câu về việc tại sao phải đi ngủ sớm đi chị.");
brain.dispose();
process.exit(0);
