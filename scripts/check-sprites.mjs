// Validates a sprite set: sprite.json shape, every frame exists, PNGs have transparency, all frames share
// one canvas size, and which optional states are missing (with what she falls back to).
// Usage: node scripts/check-sprites.mjs [folder]      default: sprites/aza
//        node scripts/check-sprites.mjs "%USERPROFILE%\.mai-companion\sprites\my-set"
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "sprites/aza");
const problems = [];
const warnings = [];
const notes = [];

const REQUIRED = ["idle", "talk"];
// state → what the app uses instead when it's missing (see src/app/renderer/pet.js `pick`)
const OPTIONAL = {
	think: "idle", tool: "idle", hi: "idle", upset: "idle", read: "tool", write: "tool",
	walk: "idle + a bouncing step", held: "surprised → upset", fall: "surprised → upset", yawn: "sleep → think",
	sleep: "idle", eat: "hi", poked: "surprised → upset", surprised: "upset",
};
const MOODS = ["neutral", "happy", "proud", "teasing", "stern", "angry", "pouty", "worried", "sleepy"];

function png(file) {
	const b = readFileSync(file);
	if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
	const colorType = b[25];
	// 4 = grey+alpha, 6 = RGBA; 3 = palette (may have a tRNS chunk for transparency)
	const alpha = colorType === 4 || colorType === 6 || (colorType === 3 && b.includes(Buffer.from("tRNS")));
	return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), alpha };
}

if (!existsSync(join(dir, "sprite.json"))) {
	console.error(`✗ ${dir} has no sprite.json`);
	process.exit(1);
}
let spec;
try {
	spec = JSON.parse(readFileSync(join(dir, "sprite.json"), "utf8"));
} catch (e) {
	console.error(`✗ sprite.json is not valid JSON: ${e.message}`);
	process.exit(1);
}
const states = spec.states ?? {};
for (const r of REQUIRED) if (!states[r]) problems.push(`missing required state "${r}"`);

const sizes = new Map();
for (const [name, st] of Object.entries(states)) {
	if (!Array.isArray(st.frames) || !st.frames.length) {
		problems.push(`state "${name}" has no frames[]`);
		continue;
	}
	for (const f of [...st.frames, ...(st.blink ? [st.blink] : [])]) {
		const p = join(dir, f);
		if (!existsSync(p)) {
			problems.push(`${name}: ${f} not found`);
			continue;
		}
		try {
			const { w, h, alpha } = png(p);
			sizes.set(`${w}x${h}`, [...(sizes.get(`${w}x${h}`) ?? []), f]);
			if (!alpha) warnings.push(`${f} has no transparency; she'll sit in a box on the desktop`);
		} catch (e) {
			problems.push(`${f}: ${e.message}`);
		}
	}
	if (st.fps !== undefined && !(st.fps > 0 && st.fps <= 30)) warnings.push(`${name}.fps ${st.fps} looks off (1–12 is typical)`);
}
if (sizes.size > 1) {
	warnings.push(`frames use ${sizes.size} different canvas sizes (${[...sizes.keys()].join(", ")}). Keep one size and one baseline or she'll jump between frames`);
}
for (const [m, s] of Object.entries(spec.moods ?? {})) {
	if (!MOODS.includes(m)) warnings.push(`moods.${m} is not a mood she uses (${MOODS.join(", ")})`);
	if (!states[s]) problems.push(`moods.${m} points at missing state "${s}"`);
}
for (const [t, s] of Object.entries(spec.tools ?? {})) if (!states[s]) problems.push(`tools.${t} points at missing state "${s}"`);
for (const [s, fallback] of Object.entries(OPTIONAL)) if (!states[s]) notes.push(`${s.padEnd(9)} → uses ${fallback}`);
for (const m of MOODS) if (!states[m] && !spec.moods?.[m] && m !== "neutral") notes.push(`${m.padEnd(9)} → mood shown with idle (add a "${m}" state or moods.${m})`);

console.log(`Sprite set: ${spec.name ?? "(no name)"}  —  ${dir}`);
console.log(`States: ${Object.keys(states).join(", ")}  ·  canvas ${[...sizes.keys()].join(", ") || "?"}  ·  pixelated: ${spec.pixelated !== false}`);
for (const p of problems) console.log(`  ✗ ${p}`);
for (const w of warnings) console.log(`  ! ${w}`);
if (notes.length) {
	console.log("  Optional states not in this set (fine, but more frames = more alive):");
	for (const n of notes) console.log(`    · ${n}`);
}
console.log(problems.length ? `\n${problems.length} problem(s): fix these before using the set.` : "\nOK: this set will load.");
process.exit(problems.length ? 1 : 0);
