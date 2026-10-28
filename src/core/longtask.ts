import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";

/**
 * "Work mode": a longer job he approved (read 100 files, tidy a folder, write a report…). The brain keeps
 * continuing turn after turn until every step is ticked off, the budget runs out, or he stops it.
 * State is saved to disk so a crash, a compaction of the chat, or a restart doesn't lose her place.
 */
export interface LongTask {
	id: string;
	goal: string;
	steps: Array<{ text: string; done: boolean }>;
	notes: string[];
	status: "running" | "done" | "stopped" | "out_of_budget";
	startedAt: number;
	finishedAt?: number;
	turns: number;
	maxTurns: number;
	deadline: number;
	summary?: string;
}

const FILE = () => join(paths.state, "task.json");

export class TaskBoard {
	current: LongTask | null = null;

	constructor() {
		try {
			if (existsSync(FILE())) this.current = JSON.parse(readFileSync(FILE(), "utf8"));
		} catch {
			this.current = null;
		}
	}

	get running(): boolean {
		return this.current?.status === "running";
	}

	save(): void {
		writeFileSync(FILE(), JSON.stringify(this.current, null, 2));
	}

	start(goal: string, steps: string[], budget: { maxTurns: number; maxMinutes: number }): LongTask {
		this.current = {
			id: randomUUID().slice(0, 6),
			goal: goal.trim(),
			steps: steps.map((t) => ({ text: t.trim(), done: false })).filter((s) => s.text),
			notes: [],
			status: "running",
			startedAt: Date.now(),
			turns: 0,
			maxTurns: budget.maxTurns,
			deadline: Date.now() + budget.maxMinutes * 60_000,
		};
		this.save();
		return this.current;
	}

	/** Tick a step (1-based), add a note, and/or finish. Unknown step numbers are ignored with a hint. */
	progress(p: { step?: number; note?: string; finished?: boolean; summary?: string; addSteps?: string[] }): string {
		const t = this.current;
		if (!t || t.status !== "running") throw new Error("No task in progress.");
		const out: string[] = [];
		if (p.step !== undefined) {
			const s = t.steps[p.step - 1];
			if (s) {
				s.done = true;
				out.push(`step ${p.step} done`);
			} else out.push(`there is no step ${p.step} (1–${t.steps.length})`);
		}
		for (const a of p.addSteps ?? []) if (a.trim()) t.steps.push({ text: a.trim(), done: false });
		if (p.note?.trim()) t.notes.push(p.note.trim().slice(0, 400));
		t.notes = t.notes.slice(-30);
		if (p.finished) {
			t.status = "done";
			t.finishedAt = Date.now();
			t.summary = p.summary?.trim();
			out.push("task finished");
		}
		this.save();
		const left = t.steps.filter((s) => !s.done).length;
		return `${out.join(", ") || "noted"}. ${left} step(s) left.`;
	}

	stop(status: "stopped" | "out_of_budget"): void {
		if (!this.current || this.current.status !== "running") return;
		this.current.status = status;
		this.current.finishedAt = Date.now();
		this.save();
	}

	/** Count one more model turn; returns false once the budget is used up. */
	tick(now = Date.now()): boolean {
		const t = this.current;
		if (!t || t.status !== "running") return false;
		t.turns++;
		this.save();
		return t.turns < t.maxTurns && now < t.deadline;
	}

	nextStep(): { index: number; text: string } | null {
		const t = this.current;
		if (!t) return null;
		const i = t.steps.findIndex((s) => !s.done);
		return i < 0 ? null : { index: i + 1, text: t.steps[i].text };
	}

	/** Prompt section while a task runs: goal, checklist, recent notes, rules. */
	describe(): string {
		const t = this.current;
		if (!t || t.status !== "running") return "";
		const steps = t.steps.map((s, i) => `  ${s.done ? "[x]" : "[ ]"} ${i + 1}. ${s.text}`).join("\n");
		const notes = t.notes.slice(-8).map((n) => `  - ${n}`).join("\n");
		const mins = Math.max(0, Math.round((t.deadline - Date.now()) / 60_000));
		return `# Work mode (he approved this; keep going without waiting for him)
Goal: ${t.goal}
Steps:
${steps}
${notes ? `Your notes so far:\n${notes}\n` : ""}Budget left: ${t.maxTurns - t.turns} turns, ${mins} min.
- Do the next unchecked step with your tools. After finishing a step, call task_progress with its number and a short note of what you found/did.
- Write findings into notes (task_progress note) as you go: the chat may be summarized and you'll rely on these notes.
- Keep chat lines short (one line per step) — he can watch, but you're working.
- If you discover more work, add steps (task_progress add_steps). If you're blocked or need his decision, say so and call task_progress with finished=true and a summary of what's left.
- When every step is done, call task_progress with finished=true and a clear summary for him.`;
	}

	/** For the UI. */
	snapshot(): { goal: string; done: number; total: number; status: LongTask["status"]; next?: string } | null {
		const t = this.current;
		if (!t) return null;
		return { goal: t.goal, done: t.steps.filter((s) => s.done).length, total: t.steps.length, status: t.status, next: this.nextStep()?.text };
	}
}
