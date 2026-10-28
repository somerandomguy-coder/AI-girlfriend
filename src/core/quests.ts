import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { paths } from "./paths.js";

/**
 * Side quests: small missions Mai gives him that the app can actually check.
 * "honor" quests can't be verified by the PC, so she asks and trusts (or teases).
 */
export type QuestCheck =
	| { kind: "file_moved"; from: string; to: string }
	| { kind: "file_exists"; path: string }
	| { kind: "folder_tidy"; folder: string; maxLooseFiles: number; pattern?: string }
	| { kind: "app_closed"; process: string }
	| { kind: "honor" };

export interface Quest {
	id: string;
	title: string;
	/** What she said when giving it (for callbacks). */
	pitch: string;
	check: QuestCheck;
	createdAt: number;
	dueAt?: number;
	status: "active" | "done" | "failed" | "expired" | "cancelled";
	reward: string;
	completedAt?: number;
}

const FILE = () => join(paths.state, "quests.json");

export function isInside(p: string, roots: string[]): boolean {
	const clean = (s: string) => resolve(s.trim().replace(/^["']|["']$/g, "")).toLowerCase();
	const full = clean(p);
	return roots.some((r) => full.startsWith(clean(r)));
}

function globToRegex(pattern: string): RegExp {
	const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${esc}$`, "i");
}

function processRunning(name: string): boolean {
	if (process.platform !== "win32") return false;
	const exe = name.toLowerCase().endsWith(".exe") ? name : `${name}.exe`;
	const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${exe}`, "/NH"], { encoding: "utf8", windowsHide: true });
	return out.toLowerCase().includes(exe.toLowerCase());
}

export class QuestBook {
	quests: Quest[] = existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), "utf8")) : [];

	constructor(private readonly allowedRoots: string[]) {}

	private save(): void {
		writeFileSync(FILE(), JSON.stringify(this.quests.slice(-200), null, 2));
	}

	active(): Quest[] {
		return this.quests.filter((q) => q.status === "active");
	}

	create(q: Pick<Quest, "title" | "pitch" | "check" | "reward"> & { dueInMinutes?: number }): Quest {
		const touched =
			q.check.kind === "file_moved" ? [q.check.from, q.check.to] : q.check.kind === "file_exists" ? [q.check.path] : q.check.kind === "folder_tidy" ? [q.check.folder] : [];
		for (const p of touched) {
			if (!isInside(p, this.allowedRoots)) throw new Error(`Path ${p} is outside the folders I'm allowed to look at (${this.allowedRoots.join(", ")}).`);
		}
		const quest: Quest = {
			id: randomUUID().slice(0, 6),
			title: q.title,
			pitch: q.pitch,
			check: q.check,
			reward: q.reward,
			createdAt: Date.now(),
			dueAt: q.dueInMinutes ? Date.now() + q.dueInMinutes * 60_000 : undefined,
			status: "active",
		};
		this.quests.push(quest);
		this.save();
		return quest;
	}

	/** Returns "done", "not_yet", or "needs_his_word" (honor quests). Marks done/expired as a side effect. */
	verify(id: string): { quest: Quest; result: "done" | "not_yet" | "needs_his_word" | "expired"; detail: string } {
		const q = this.quests.find((x) => x.id === id);
		if (!q) throw new Error(`No quest with id ${id}`);
		const c = q.check;
		let ok = false;
		let detail = "";
		switch (c.kind) {
			case "file_moved":
				ok = !existsSync(c.from) && existsSync(c.to);
				detail = `source ${existsSync(c.from) ? "still there" : "gone"}, destination ${existsSync(c.to) ? "exists" : "missing"}`;
				break;
			case "file_exists":
				ok = existsSync(c.path);
				detail = ok ? "file is there" : "file not found";
				break;
			case "folder_tidy": {
				const re = c.pattern ? globToRegex(c.pattern) : null;
				const loose = existsSync(c.folder)
					? readdirSync(c.folder, { withFileTypes: true }).filter((d) => d.isFile() && (!re || re.test(d.name))).length
					: 0;
				ok = loose <= c.maxLooseFiles;
				detail = `${loose} loose file(s) left (target ≤ ${c.maxLooseFiles})`;
				break;
			}
			case "app_closed":
				ok = !processRunning(c.process);
				detail = ok ? `${c.process} is closed` : `${c.process} is still running`;
				break;
			case "honor":
				return { quest: q, result: "needs_his_word", detail: "Can't check this from the PC — ask him." };
		}
		if (ok) {
			q.status = "done";
			q.completedAt = Date.now();
			this.save();
			return { quest: q, result: "done", detail };
		}
		if (q.dueAt && Date.now() > q.dueAt) {
			q.status = "expired";
			this.save();
			return { quest: q, result: "expired", detail };
		}
		return { quest: q, result: "not_yet", detail };
	}

	setStatus(id: string, status: Quest["status"]): Quest {
		const q = this.quests.find((x) => x.id === id);
		if (!q) throw new Error(`No quest with id ${id}`);
		q.status = status;
		if (status === "done") q.completedAt = Date.now();
		this.save();
		return q;
	}

	describe(): string {
		const a = this.active();
		if (!a.length) return "Side quests: none active.";
		return `Side quests active: ${a
			.map((q) => `[${q.id}] ${q.title}${q.dueAt ? ` (due ${new Date(q.dueAt).toLocaleTimeString()})` : ""}`)
			.join("; ")}`;
	}

	stats(): { done: number; failed: number } {
		return {
			done: this.quests.filter((q) => q.status === "done").length,
			failed: this.quests.filter((q) => q.status === "failed" || q.status === "expired").length,
		};
	}
}
