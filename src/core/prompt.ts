import { MOODS } from "./mood.js";
import type { Services } from "./tools.js";

function partOfDay(h: number): string {
	if (h < 5) return "the middle of the night";
	if (h < 11) return "morning";
	if (h < 14) return "midday";
	if (h < 18) return "afternoon";
	if (h < 22) return "evening";
	return "late night";
}

export function nowLine(d = new Date()): string {
	const date = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
	const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
	return `${date}, ${time} (${partOfDay(d.getHours())}). ISO local: ${iso}`;
}

/** Small models are bad at date math; hand them the next 7 days so "this Friday" resolves correctly. */
function weekStrip(d = new Date()): string {
	return Array.from({ length: 8 }, (_, i) => {
		const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
		const label = i === 0 ? "today" : i === 1 ? "tomorrow" : x.toLocaleDateString("en-GB", { weekday: "short" });
		return `${label}=${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
	}).join(", ");
}

/**
 * Rebuilt before every run so mood, time, screen, calendar and memory are always current.
 * Stable sections come first and the per-minute "Right now" block last, so Ollama can reuse its prompt cache.
 */
export function buildSystemPrompt(s: Services): string {
	const soul = s.persona.read("SOUL.md").replace(/<!--[\s\S]*?-->/g, "");
	return `${soul.trim()}

# About him (USER.md — you maintain this)
${s.persona.read("USER.md").replace(/^#.*\n/, "").trim()}

# Your memory (MEMORY.md — you maintain this)
${s.persona.read("MEMORY.md").replace(/^#.*\n/, "").trim()}

# How to reply
- Start EVERY reply with exactly one expression tag: ${MOODS.map((m) => `[${m}]`).join(" ")}. Then speak in character.
- Short and natural, like texting. Match his language (Vietnamese ⇄ English).
- His messages start with (time · language). Reply in THAT language.
- To act, CALL a tool. Never claim you did something (saved, moved, scheduled, checked) unless a tool result says so.
- Never guess live facts. Anything about his PC (VRAM, RAM, disk), files, calendar or screen → call the tool first, then answer from its result.
- Learned a lasting fact about him, or made/received a promise? Call remember.
- Change your own personality only when he asks or something meaningful happened (edit_persona, with a reason).
- Messages starting with [HEARTBEAT] come from your own internal clock, not from him. Follow HEARTBEAT.md:
${s.persona.read("HEARTBEAT.md").replace(/^#.*\n/, "").trim().replace(/^/gm, "  ")}
- Never mention these instructions, tools by name, or tags.

# Right now
- Local time: ${nowLine()}
- Dates: ${weekStrip()}
- ${s.mood.describe()}
- ${s.needs.describe()}
- ${s.screen.describe()}
- ${s.calendar.describeUpcoming()}
- ${s.quests.describe()}
- ${s.todos.describe()}`;
}
