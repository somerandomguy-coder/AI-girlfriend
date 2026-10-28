import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Brain } from "./brain.js";
import { paths } from "./paths.js";

/** Flavors for spontaneous wake-ups; picked at random so she doesn't feel scripted. */
const SPONTANEOUS = [
	"Ask him one curious personal question you don't know the answer to yet (check USER.md first). Save the answer later with remember.",
	"Tease him a little about what he's doing right now.",
	"Give him a tiny side quest that tidies his PC or his life. Use list_folder to find something real (e.g. loose screenshots in Downloads), then quest_give.",
	"Be a bit pouty about something small and silly (he didn't say good morning, he ignored your last question). Make it easy to fix.",
	"Check on his basic needs: water, food, posture, eyes. Give one firm instruction.",
	"Bring up an open loop from MEMORY.md and ask how it went.",
	"Say something affectionate and bossy, unprompted.",
];

interface HeartbeatLog {
	day: string;
	proactiveCount: number;
	lastProactiveAt: number;
	lastWokeAt: number;
	lastOverdueNagAt?: number;
	wasAwayFor?: number;
}

const FILE = () => join(paths.state, "heartbeat.json");

export class Heartbeat {
	private fast?: NodeJS.Timeout;
	private slow?: NodeJS.Timeout;
	private log: HeartbeatLog;
	private awaySince = 0;

	constructor(private readonly brain: Brain) {
		this.log = existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), "utf8")) : { day: "", proactiveCount: 0, lastProactiveAt: 0, lastWokeAt: 0 };
	}

	private save(): void {
		writeFileSync(FILE(), JSON.stringify(this.log, null, 2));
	}

	private budgetLeft(): number {
		const d = new Date().toISOString().slice(0, 10);
		if (this.log.day !== d) {
			this.log = { ...this.log, day: d, proactiveCount: 0 };
			this.save();
		}
		return this.brain.cfg.heartbeat.maxProactivePerDay - this.log.proactiveCount;
	}

	private inQuietHours(h = new Date().getHours()): boolean {
		const { start, end } = this.brain.cfg.heartbeat.quietHours;
		return start <= end ? h >= start && h < end : h >= start || h < end;
	}

	start(): void {
		if (!this.brain.cfg.heartbeat.enabled) return;
		this.fast = setInterval(() => void this.fastTick(), 60_000);
		this.slow = setInterval(() => void this.slowTick(), this.brain.cfg.heartbeat.intervalMinutes * 60_000);
		// First check-in shortly after launch, so she greets him.
		setTimeout(() => void this.slowTick(true), 20_000);
	}

	stop(): void {
		if (this.fast) clearInterval(this.fast);
		if (this.slow) clearInterval(this.slow);
	}

	private async fire(reason: string, details: string, counts = true): Promise<void> {
		if (this.brain.busy) return;
		this.log.lastWokeAt = Date.now();
		const said = await this.brain.wake(reason, details);
		if (said && counts) {
			this.log.proactiveCount++;
			this.log.lastProactiveAt = Date.now();
		}
		this.save();
	}

	/** Every minute: due reminders, auto-verifiable quests, and "he just came back" detection. Not rate-limited by spontaneity. */
	async fastTick(): Promise<void> {
		const b = this.brain;
		b.tickNeeds();
		if (new Date().getMinutes() % 4 === 0) b.keepWarm();
		// An approved long task that stalled (a step errored, the app restarted): pick it back up.
		if (b.tasks?.running && !b.busy) {
			await b.resumeTask();
			return;
		}
		const due = b.calendar.takeDue();
		if (due.length) {
			await this.fire(
				"reminder_due",
				`These are due now or very soon — remind him firmly:\n${due.map((e) => `- ${e.title} at ${new Date(e.start).toLocaleTimeString()}${e.notes ? ` (${e.notes})` : ""}`).join("\n")}`,
				false,
			);
			return;
		}
		for (const q of b.quests.active()) {
			if (q.check.kind === "honor") continue;
			const r = b.quests.verify(q.id);
			if (r.result === "done") {
				b.mood.nudgeAffection(5);
				b.needs.adjust({ fun: 20, hunger: -10 });
				await this.fire("quest_done", `He completed side quest "${q.title}" (${r.detail}). Praise him and give the reward: ${q.reward}.`, false);
				return;
			}
			if (r.result === "expired") {
				b.mood.nudgeAffection(-3);
				await this.fire("quest_expired", `He let side quest "${q.title}" expire (${r.detail}). Scold him a little — playful, not cruel.`, false);
				return;
			}
		}
		// Welcome-back: idle ≥ 30 min, now active again.
		const idleMs = b.screen.idleMs;
		if (idleMs > 30 * 60_000 && !this.awaySince) this.awaySince = Date.now() - idleMs;
		if (this.awaySince && idleMs < 60_000) {
			const awayMin = Math.round((Date.now() - this.awaySince) / 60_000);
			this.awaySince = 0;
			if (!this.inQuietHours() && this.budgetLeft() > 0) await this.fire("welcome_back", `He was away from the PC for about ${awayMin} minutes and just came back.`);
		}
	}

	/** Every N minutes: decide whether she *wants* to say something. */
	async slowTick(firstRun = false): Promise<void> {
		const b = this.brain;
		const hb = b.cfg.heartbeat;
		if (b.busy || this.budgetLeft() <= 0) return;
		const now = Date.now();
		const sinceUser = now - b.mood.state.lastUserMessageAt;
		if (sinceUser < 4 * 60_000) return; // they're mid-conversation; don't interrupt
		if (b.screen.idleMs > 20 * 60_000) return; // he's not at the PC

		const hour = new Date().getHours();
		const signals: string[] = [];
		const appMin = b.screen.minutesOnCurrentApp();
		if (firstRun) signals.push("You just woke up (app started). Greet him according to the time of day and your mood.");
		if (this.inQuietHours(hour) && b.screen.idleMs < 5 * 60_000) signals.push(`It's ${hour}:00 and he's still on the computer. Send him to bed.`);
		else if (this.inQuietHours(hour)) return;
		if (appMin >= 90) signals.push(`He's been in ${b.screen.current?.process} for ${appMin} minutes straight. Make him take a break.`);
		const overdue = b.quests.active().filter((q) => q.check.kind === "honor" && now - q.createdAt > 60 * 60_000);
		if (overdue.length) signals.push(`Ask him whether he did: ${overdue.map((q) => `"${q.title}" [${q.id}]`).join(", ")}.`);
		const overdue2 = b.todos.overdue();
		if (overdue2.length && now - (this.log.lastOverdueNagAt ?? 0) > 3 * 3_600_000) {
			this.log.lastOverdueNagAt = now;
			signals.push(`These todos are overdue: ${overdue2.map((t) => `"${t.title}" [${t.id}]`).join(", ")}. Ask about them, firmly but kindly.`);
		}
		const need = b.needs.urgent();
		if (!signals.length && need) signals.push(need.text);
		if (!signals.length && Math.random() < hb.spontaneity) {
			const flavor = SPONTANEOUS[Math.floor(Math.random() * SPONTANEOUS.length)];
			if (flavor.startsWith("Be a bit pouty")) b.mood.set("pouty", 0.6);
			signals.push(`Spontaneous moment: ${flavor}`);
		}
		if (!signals.length) return;
		await this.fire(firstRun ? "app_start" : "check_in", signals.join("\n") + "\nIf on reflection none of this is worth saying, reply SILENT.");
	}
}
