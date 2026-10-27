import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";

/** Expressions she can show; each maps to a sprite state and a TTS style. */
export const MOODS = ["neutral", "happy", "proud", "teasing", "stern", "angry", "pouty", "worried", "sleepy"] as const;
export type Mood = (typeof MOODS)[number];

export interface MoodState {
	/** Slow-moving bond, -100..100. Grows with kept promises/finished quests, drops when ignored. */
	affection: number;
	/** Fast-moving current expression. */
	mood: Mood;
	/** 0..1, decays back toward 0 so moods fade. */
	intensity: number;
	updatedAt: number;
	lastUserMessageAt: number;
	/** Consecutive days he talked to her; celebrated, never punished. */
	streakDays: number;
	lastStreakDay: string;
}

const FILE = () => join(paths.state, "mood.json");

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const today = () => new Date().toISOString().slice(0, 10);

export class MoodEngine {
	state: MoodState;

	constructor() {
		this.state = existsSync(FILE())
			? JSON.parse(readFileSync(FILE(), "utf8"))
			: { affection: 10, mood: "neutral", intensity: 0, updatedAt: Date.now(), lastUserMessageAt: 0, streakDays: 0, lastStreakDay: "" };
	}

	save(): void {
		writeFileSync(FILE(), JSON.stringify(this.state, null, 2));
	}

	/** Moods fade with a ~45 minute half-life. */
	decay(now = Date.now()): void {
		const hours = (now - this.state.updatedAt) / 3_600_000;
		this.state.intensity *= Math.pow(0.5, hours / 0.75);
		if (this.state.intensity < 0.15) {
			this.state.mood = "neutral";
			this.state.intensity = 0;
		}
		this.state.updatedAt = now;
	}

	set(mood: Mood, intensity = 0.7): void {
		this.decay();
		this.state.mood = mood;
		this.state.intensity = clamp(intensity, 0, 1);
		this.save();
	}

	nudgeAffection(delta: number): void {
		this.state.affection = clamp(this.state.affection + delta, -100, 100);
		this.save();
	}

	onUserMessage(): { newStreakDay: boolean } {
		this.state.lastUserMessageAt = Date.now();
		let newStreakDay = false;
		const d = today();
		if (this.state.lastStreakDay !== d) {
			const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
			this.state.streakDays = this.state.lastStreakDay === y ? this.state.streakDays + 1 : 1;
			this.state.lastStreakDay = d;
			newStreakDay = true;
		}
		this.save();
		return { newStreakDay };
	}

	/** One line injected into the system prompt each turn. */
	describe(): string {
		this.decay();
		const a = this.state.affection;
		const bond = a > 60 ? "very attached to him" : a > 25 ? "fond of him" : a > -10 ? "warming up to him" : "annoyed with him lately";
		const strength = this.state.intensity > 0.6 ? "strongly" : this.state.intensity > 0.3 ? "somewhat" : "barely";
		return `Current mood: ${this.state.mood} (${strength}). Affection ${a}/100 — you are ${bond}. Chat streak: ${this.state.streakDays} day(s).`;
	}
}
