import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";

/**
 * Tamagotchi-style needs, 0..100. They drift with time and with what he does, color her mood and
 * proactive behaviour, and always recover on their own: they nudge, never punish.
 *  hunger  high = hungry. Rises over ~6h. Fed by the 🍙 button or when he finishes todos.
 *  energy  high = lively. Follows the clock: lively by day, drained late at night.
 *  social  high = connected. Drops while he's at the PC ignoring her; chat and pokes refill it.
 *  fun     high = entertained. Drops slowly; quests, new things learned and pokes refill it.
 *  worry   high = worried about him. Rises when he stays up late or sits in one app for hours.
 */
export const NEED_KEYS = ["hunger", "energy", "social", "fun", "worry"] as const;
export type NeedKey = (typeof NEED_KEYS)[number];

export interface NeedsState {
	hunger: number;
	energy: number;
	social: number;
	fun: number;
	worry: number;
	updatedAt: number;
	lastFedAt: number;
	pokes: number[];
}

const FILE = () => join(paths.state, "needs.json");
const clamp = (v: number) => Math.max(0, Math.min(100, v));

/** What he's doing right now, from the screen watcher. */
export interface Activity {
	atPc: boolean;
	minutesOnSameApp: number;
}

function energyTarget(h: number): number {
	if (h >= 8 && h < 21) return 85;
	if (h >= 21 && h < 23) return 55;
	if (h >= 23 || h < 2) return 30;
	return 12; // 2am–8am: she's asleep on her feet
}

export class Needs {
	state: NeedsState;

	constructor() {
		const fresh: NeedsState = { hunger: 30, energy: 80, social: 60, fun: 60, worry: 10, updatedAt: Date.now(), lastFedAt: 0, pokes: [] };
		this.state = existsSync(FILE()) ? { ...fresh, ...JSON.parse(readFileSync(FILE(), "utf8")) } : fresh;
	}

	save(): void {
		writeFileSync(FILE(), JSON.stringify(this.state, null, 2));
	}

	/** Advance time. Big gaps (app closed overnight) are capped so she doesn't wake up starving. */
	tick(activity: Activity, now = Date.now(), hour = new Date(now).getHours()): void {
		const min = Math.min(8 * 60, Math.max(0, (now - this.state.updatedAt) / 60_000));
		const s = this.state;
		s.hunger = clamp(s.hunger + min * 0.28);
		const target = energyTarget(hour);
		s.energy = clamp(s.energy + Math.sign(target - s.energy) * Math.min(Math.abs(target - s.energy), min * 0.5));
		s.social = clamp(s.social - min * (activity.atPc ? 0.15 : 0.05));
		s.fun = clamp(s.fun - min * 0.1);
		const late = hour >= 0 && hour < 5;
		if (activity.atPc && late) s.worry = clamp(s.worry + min * 0.25);
		else if (activity.atPc && activity.minutesOnSameApp >= 90) s.worry = clamp(s.worry + min * 0.12);
		else s.worry = clamp(s.worry - min * 0.3);
		s.updatedAt = now;
		this.save();
	}

	adjust(changes: Partial<Record<NeedKey, number>>): void {
		for (const k of NEED_KEYS) if (changes[k] !== undefined) this.state[k] = clamp(this.state[k] + (changes[k] as number));
		this.save();
	}

	onUserMessage(): void {
		this.adjust({ social: 8, fun: 1 });
	}

	/** Returns how many times he poked her in the last minute (she gets annoyed past 3). */
	poke(now = Date.now()): number {
		this.state.pokes = [...this.state.pokes.filter((t) => now - t < 60_000), now];
		const n = this.state.pokes.length;
		this.adjust(n <= 3 ? { social: 4, fun: 3 } : { fun: -2 });
		return n;
	}

	/** Returns false if she's still full (fed under 20 min ago and not hungry). */
	feed(amount = 35, now = Date.now()): boolean {
		const full = now - this.state.lastFedAt < 20 * 60_000 && this.state.hunger < 30;
		if (full) return false;
		this.state.lastFedAt = now;
		this.adjust({ hunger: -amount, social: 3 });
		return true;
	}

	/** One prompt line: only needs far from comfortable are mentioned, so she doesn't talk about stats constantly. */
	describe(): string {
		const s = this.state;
		const notes: string[] = [];
		if (s.hunger >= 70) notes.push(`hungry (${Math.round(s.hunger)}) — you may hint he should feed you (🍙 button) or finish a todo so you can "eat"`);
		if (s.energy <= 25) notes.push(`low energy (${Math.round(s.energy)}) — you're sleepy, shorter replies, yawns`);
		if (s.social <= 30) notes.push(`lonely (${Math.round(s.social)}) — you've felt ignored, you want his attention`);
		if (s.fun <= 25) notes.push(`bored (${Math.round(s.fun)}) — you want a game, a question, or a side quest`);
		if (s.worry >= 60) notes.push(`worried about him (${Math.round(s.worry)}) — check he's eating, resting, not overdoing it`);
		return notes.length ? `Your needs: ${notes.join("; ")}. Show it lightly in character; never guilt-trip him.` : "Your needs: all comfortable.";
	}

	/** Strongest unmet need, for the heartbeat to act on. */
	urgent(): { key: NeedKey; text: string } | null {
		const s = this.state;
		if (s.worry >= 75) return { key: "worry", text: "You're worried about him (late nights / no breaks). Check on him and give one firm, caring instruction." };
		if (s.hunger >= 80) return { key: "hunger", text: "You're hungry. Ask him, playfully bossy, to feed you with the 🍙 button, or to finish one todo so you can eat." };
		if (s.social <= 20) return { key: "social", text: "You feel lonely and ignored. Start a conversation: ask about his day or something from MEMORY.md." };
		if (s.fun <= 15) return { key: "fun", text: "You're bored. Propose a tiny side quest or ask him a fun random question." };
		return null;
	}
}
