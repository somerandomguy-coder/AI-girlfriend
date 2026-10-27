import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";

export interface CalendarEvent {
	id: string;
	title: string;
	/** ISO 8601 local or UTC. */
	start: string;
	end?: string;
	notes?: string;
	/** Minutes before start to nag him. */
	remindBefore: number;
	/** Repeat rule, kept tiny on purpose. */
	repeat?: "daily" | "weekly";
	reminded?: boolean;
	createdBy: "mai" | "user";
}

const FILE = () => join(paths.state, "calendar.json");

/** Local calendar + reminders. Google Calendar sync can layer on top later (v2). */
export class Calendar {
	events: CalendarEvent[] = existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), "utf8")) : [];

	private save(): void {
		writeFileSync(FILE(), JSON.stringify(this.events, null, 2));
	}

	add(e: Omit<CalendarEvent, "id" | "reminded">): CalendarEvent {
		if (Number.isNaN(Date.parse(e.start))) throw new Error(`Invalid start time "${e.start}". Use ISO 8601 like 2026-10-28T09:00.`);
		const ev: CalendarEvent = { ...e, id: randomUUID().slice(0, 8), reminded: false };
		this.events.push(ev);
		this.events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
		this.save();
		return ev;
	}

	remove(id: string): boolean {
		const n = this.events.length;
		this.events = this.events.filter((e) => e.id !== id);
		this.save();
		return this.events.length !== n;
	}

	upcoming(hours = 48, now = Date.now()): CalendarEvent[] {
		return this.events.filter((e) => {
			const t = Date.parse(e.start);
			return t >= now - 3_600_000 && t <= now + hours * 3_600_000;
		});
	}

	/** Events whose reminder window has opened; marks them so each fires once (repeats roll forward). */
	takeDue(now = Date.now()): CalendarEvent[] {
		const due: CalendarEvent[] = [];
		for (const e of this.events) {
			const t = Date.parse(e.start);
			if (!e.reminded && now >= t - e.remindBefore * 60_000 && now <= t + 30 * 60_000) {
				due.push({ ...e });
				if (e.repeat) {
					const step = e.repeat === "daily" ? 86_400_000 : 7 * 86_400_000;
					let next = t + step;
					while (next < now) next += step;
					e.start = new Date(next).toISOString();
				} else {
					e.reminded = true;
				}
			}
		}
		if (due.length) this.save();
		return due;
	}

	describeUpcoming(): string {
		const list = this.upcoming(24);
		if (!list.length) return "Calendar (next 24h): nothing.";
		return `Calendar (next 24h): ${list.map((e) => `${new Date(e.start).toLocaleString()} — ${e.title} [id ${e.id}]`).join("; ")}`;
	}
}
