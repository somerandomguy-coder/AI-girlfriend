import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";

/**
 * Persona files (SOUL/USER/MEMORY/HEARTBEAT.md) live in a private git repo.
 * Every edit — by Mai or by the user — is a commit, so any version can be restored.
 * Rollback never rewrites history: it commits the old content on top.
 */
export const PERSONA_FILES = ["SOUL.md", "USER.md", "MEMORY.md", "HEARTBEAT.md"] as const;
export type PersonaFile = (typeof PERSONA_FILES)[number];

const LOCK_MARKER = "<!-- LOCKED";

export interface PersonaVersion {
	rev: string;
	date: string;
	author: string;
	message: string;
}

export class PersonaStore {
	constructor(private readonly dir = paths.persona) {}

	private git(...args: string[]): string {
		return execFileSync("git", args, { cwd: this.dir, encoding: "utf8", windowsHide: true }).trim();
	}

	init(): void {
		for (const f of PERSONA_FILES) {
			const target = join(this.dir, f);
			if (!existsSync(target)) copyFileSync(join(paths.personaTemplate, f), target);
		}
		if (!existsSync(join(this.dir, ".git"))) {
			this.git("init", "-q");
			this.git("config", "user.name", "mai-companion");
			this.git("config", "user.email", "mai@localhost");
			this.git("config", "core.autocrlf", "false");
			this.commit("Initial persona", "system");
		}
	}

	read(file: PersonaFile): string {
		return readFileSync(join(this.dir, file), "utf8");
	}

	files(): string[] {
		return readdirSync(this.dir).filter((f) => f.endsWith(".md"));
	}

	/**
	 * Write a persona file and commit it.
	 * When Mai is the author, the LOCKED tail of SOUL.md is preserved no matter what she sends.
	 */
	write(file: PersonaFile, content: string, reason: string, author: "mai" | "user" | "system"): PersonaVersion | null {
		if (author === "mai") content = this.preserveLocked(file, content);
		writeFileSync(join(this.dir, file), content.endsWith("\n") ? content : `${content}\n`);
		return this.commit(reason, author);
	}

	append(file: PersonaFile, line: string, reason: string, author: "mai" | "user"): PersonaVersion | null {
		const cur = this.read(file).replace(/\s+$/, "");
		return this.write(file, `${cur}\n- ${line.trim()}\n`, reason, author);
	}

	/** Replace an exact snippet; throws if not found so the model learns to quote precisely. */
	replace(file: PersonaFile, oldText: string, newText: string, reason: string, author: "mai" | "user"): PersonaVersion | null {
		const cur = this.read(file);
		if (!cur.includes(oldText)) throw new Error(`Text not found in ${file}. Quote it exactly as it appears.`);
		if (author === "mai" && file === "SOUL.md" && cur.indexOf(oldText) >= cur.indexOf(LOCK_MARKER) && cur.includes(LOCK_MARKER)) {
			throw new Error("That part of SOUL.md is locked. Only the user can change it.");
		}
		return this.write(file, cur.replace(oldText, newText), reason, author);
	}

	private preserveLocked(file: PersonaFile, next: string): string {
		if (file !== "SOUL.md") return next;
		const cur = this.read(file);
		const i = cur.indexOf(LOCK_MARKER);
		if (i < 0) return next;
		const locked = cur.slice(i);
		const j = next.indexOf(LOCK_MARKER);
		const head = (j >= 0 ? next.slice(0, j) : next).replace(/\s+$/, "");
		return `${head}\n\n${locked}`;
	}

	private commit(message: string, author: string): PersonaVersion | null {
		this.git("add", "-A");
		if (!this.git("status", "--porcelain")) return null;
		this.git("commit", "-q", "-m", `[${author}] ${message}`);
		return this.history(1)[0] ?? null;
	}

	history(limit = 50): PersonaVersion[] {
		const out = this.git("log", `-${limit}`, "--pretty=format:%h%x1f%cI%x1f%s");
		if (!out) return [];
		return out.split("\n").map((line) => {
			const [rev, date, subject] = line.split("\x1f");
			const m = /^\[(\w+)\]\s*(.*)$/.exec(subject ?? "");
			return { rev, date, author: m?.[1] ?? "?", message: m?.[2] ?? subject };
		});
	}

	diff(rev: string): string {
		return this.git("show", "--stat", "--patch", "--no-color", rev);
	}

	/** Restore all persona files to how they were at `rev`, as a new commit. */
	rollback(rev: string): PersonaVersion | null {
		if (!/^[0-9a-f]{4,40}$/i.test(rev)) throw new Error("Invalid revision");
		this.git("checkout", rev, "--", ".");
		return this.commit(`Rollback to ${rev}`, "user");
	}
}
