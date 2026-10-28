import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

/**
 * File exploring and editing for Mai, in the style of coding agents (pi, Claude Code):
 * exact-text edits instead of rewriting whole files, line-numbered reads, and searches that skip
 * dependency/build folders. Every change keeps a backup of the original.
 */

/** Folders that are huge and almost never what he means. Searched only when she asks for them by name. */
export const HEAVY_DIRS = new Set([
	"node_modules", ".git", ".hg", ".svn", ".venv", "venv", "env", "__pycache__", ".mypy_cache", ".pytest_cache", ".tox",
	"dist", "build", "out", "target", ".next", ".nuxt", ".turbo", ".cache", ".gradle", ".idea", ".vs", "bin", "obj",
	"site-packages", "vendor", "coverage", "$RECYCLE.BIN", "System Volume Information",
]);

const MAX_EDIT_BYTES = 2 * 1024 * 1024;

export interface WalkOptions {
	/** Also descend into HEAVY_DIRS. */
	includeHeavy?: boolean;
	maxDepth?: number;
	/** Stop after visiting this many entries (keeps a stray "search all of C:\" bounded). */
	maxEntries?: number;
}

export interface WalkEntry {
	path: string;
	rel: string;
	dir: boolean;
	depth: number;
}

/** Breadth-first walk; skipped heavy folders are reported once each so she knows they exist. */
export function walk(root: string, opts: WalkOptions = {}): { entries: WalkEntry[]; skipped: string[]; truncated: boolean } {
	const maxDepth = opts.maxDepth ?? 12;
	const maxEntries = opts.maxEntries ?? 20_000;
	const entries: WalkEntry[] = [];
	const skipped: string[] = [];
	const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
	while (queue.length) {
		const { dir, depth } = queue.shift()!;
		let items;
		try {
			items = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue; // no permission, vanished, …
		}
		items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
		for (const d of items) {
			const path = join(dir, d.name);
			const isDir = d.isDirectory();
			if (isDir && HEAVY_DIRS.has(d.name) && !opts.includeHeavy) {
				skipped.push(relative(root, path) || d.name);
				continue;
			}
			entries.push({ path, rel: relative(root, path), dir: isDir, depth: depth + 1 });
			if (entries.length >= maxEntries) return { entries, skipped, truncated: true };
			if (isDir && depth + 1 < maxDepth) queue.push({ dir: path, depth: depth + 1 });
		}
	}
	return { entries, skipped, truncated: false };
}

/** Glob → RegExp over forward-slash relative paths. `*` stays in one folder, `**` crosses folders. */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			re += ".*";
			i++;
			if (glob[i + 1] === "/") i++;
		} else if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	// A pattern without a slash matches the file name anywhere ("*.pdf" finds nested PDFs too).
	return new RegExp(glob.includes("/") ? `^${re}$` : `(^|/)${re}$`, "i");
}

export function findFiles(root: string, pattern: string, opts: WalkOptions & { limit?: number } = {}) {
	const re = globToRegExp(pattern.replace(/\\/g, "/"));
	const w = walk(root, opts);
	const matches = w.entries.filter((e) => re.test(e.rel.replace(/\\/g, "/")));
	const limit = opts.limit ?? 100;
	return { matches: matches.slice(0, limit), total: matches.length, skipped: w.skipped, truncated: w.truncated };
}

function isProbablyText(buf: Buffer): boolean {
	const n = Math.min(buf.length, 8192);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
	return true;
}

export interface SearchHit {
	file: string;
	line: number;
	text: string;
}

/** Search text files for a string (case-insensitive) or a /regex/. Binary and >2 MB files are skipped. */
export function searchFiles(root: string, query: string, opts: WalkOptions & { glob?: string; limit?: number } = {}) {
	const rx = /^\/(.+)\/([gimsuy]*)$/.exec(query);
	const re = rx ? new RegExp(rx[1], rx[2].replace("g", "")) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
	const fileRe = opts.glob ? globToRegExp(opts.glob.replace(/\\/g, "/")) : null;
	const limit = opts.limit ?? 60;
	const w = walk(root, opts);
	const hits: SearchHit[] = [];
	let filesWithHits = 0;
	for (const e of w.entries) {
		if (e.dir || (fileRe && !fileRe.test(e.rel.replace(/\\/g, "/")))) continue;
		let buf: Buffer;
		try {
			if (statSync(e.path).size > MAX_EDIT_BYTES) continue;
			buf = readFileSync(e.path);
		} catch {
			continue;
		}
		if (!isProbablyText(buf)) continue;
		const lines = buf.toString("utf8").split(/\r?\n/);
		let found = false;
		for (let i = 0; i < lines.length; i++) {
			if (!re.test(lines[i])) continue;
			found = true;
			if (hits.length < limit) hits.push({ file: e.rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
		}
		if (found) filesWithHits++;
	}
	return { hits, filesWithHits, truncatedResults: hits.length >= limit, skipped: w.skipped };
}

/** Indented tree with file counts; heavy folders shown as "(skipped)". */
export function folderTree(root: string, depth = 2, includeHeavy = false): string {
	const w = walk(root, { maxDepth: depth, includeHeavy, maxEntries: 3000 });
	const lines = [basename(root) + "/"];
	for (const e of w.entries) {
		const indent = "  ".repeat(e.depth);
		if (e.dir) {
			let n = 0;
			try {
				n = readdirSync(e.path).length;
			} catch {}
			lines.push(`${indent}${basename(e.path)}/  (${n} items)`);
		} else {
			let size = 0;
			try {
				size = statSync(e.path).size;
			} catch {}
			lines.push(`${indent}${basename(e.path)}  ${size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`}`);
		}
	}
	if (w.skipped.length) lines.push(`(skipped heavy folders: ${w.skipped.slice(0, 12).join(", ")}${w.skipped.length > 12 ? ", …" : ""})`);
	if (w.truncated) lines.push("(stopped early: too many entries; look at a subfolder)");
	return lines.join("\n");
}

// ---------------------------------------------------------------- reading by lines

export function readLines(path: string, start = 1, end?: number): { text: string; total: number; from: number; to: number } {
	const all = readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
	const from = Math.max(1, start);
	const to = Math.min(all.length, end ?? from + 199);
	const width = String(to).length;
	const text = all
		.slice(from - 1, to)
		.map((l, i) => `${String(from + i).padStart(width)}│ ${l}`)
		.join("\n");
	return { text, total: all.length, from, to };
}

// ---------------------------------------------------------------- editing

interface TextFile {
	body: string;
	eol: "\r\n" | "\n";
	bom: boolean;
}

function loadText(path: string): TextFile {
	const buf = readFileSync(path);
	if (buf.length > MAX_EDIT_BYTES) throw new Error("File is over 2 MB; too big to edit safely.");
	if (!isProbablyText(buf)) throw new Error("That's a binary file (Word, PDF, image…); I can only edit plain-text files.");
	let s = buf.toString("utf8");
	const bom = s.startsWith("\uFEFF");
	if (bom) s = s.slice(1);
	const eol = s.includes("\r\n") ? "\r\n" : "\n";
	return { body: s.replace(/\r\n/g, "\n"), eol, bom };
}

function saveText(path: string, f: TextFile): void {
	writeFileSync(path, (f.bom ? "\uFEFF" : "") + (f.eol === "\r\n" ? f.body.replace(/\n/g, "\r\n") : f.body));
}

/** Copy the current file into the backup folder before changing it; keeps the newest 200 backups. */
export function backupFile(path: string, backupRoot: string): string | null {
	if (!existsSync(path)) return null;
	mkdirSync(backupRoot, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dest = join(backupRoot, `${stamp}__${basename(path)}`);
	copyFileSync(path, dest);
	const all = readdirSync(backupRoot).sort();
	for (const old of all.slice(0, Math.max(0, all.length - 200))) rmSync(join(backupRoot, old), { force: true });
	return dest;
}

export interface Edit {
	oldText: string;
	newText: string;
}

/** Count non-overlapping occurrences. */
function count(hay: string, needle: string): number {
	let n = 0;
	for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
	return n;
}

/**
 * Apply exact-text replacements, each matched against the ORIGINAL text (like pi's edit tool).
 * Every oldText must occur exactly once; overlapping edits are rejected. Returns the new text.
 */
export function applyEdits(original: string, edits: Edit[]): string {
	if (!edits.length) throw new Error("No edits given.");
	const spans: Array<{ start: number; end: number; newText: string }> = [];
	for (const [i, e] of edits.entries()) {
		const oldText = e.oldText.replace(/\r\n/g, "\n");
		if (!oldText) throw new Error(`Edit ${i + 1}: old_text is empty. Use insert_text or write_file to add new content.`);
		const n = count(original, oldText);
		if (n === 0) {
			// Help her recover: show the line that contains the start of what she quoted, if any.
			const firstLine = oldText.split("\n")[0].trim();
			const near = firstLine ? original.split("\n").findIndex((l) => l.includes(firstLine.slice(0, 40))) : -1;
			throw new Error(
				`Edit ${i + 1}: old_text not found. Copy it exactly from read_file output (without the line numbers).${near >= 0 ? ` Closest: line ${near + 1}.` : ""}`,
			);
		}
		if (n > 1) throw new Error(`Edit ${i + 1}: old_text appears ${n} times. Include more surrounding lines so it's unique.`);
		const start = original.indexOf(oldText);
		spans.push({ start, end: start + oldText.length, newText: e.newText.replace(/\r\n/g, "\n") });
	}
	spans.sort((a, b) => a.start - b.start);
	for (let i = 1; i < spans.length; i++) if (spans[i].start < spans[i - 1].end) throw new Error("Two edits overlap. Merge them into one edit.");
	let out = "";
	let pos = 0;
	for (const s of spans) {
		out += original.slice(pos, s.start) + s.newText;
		pos = s.end;
	}
	return out + original.slice(pos);
}

/** Insert text before/after a 1-based line; line 0 with "after" = top of file, a huge line = bottom. */
export function insertAtLine(original: string, line: number, text: string, position: "before" | "after" = "after"): string {
	const lines = original.split("\n");
	const at = Math.max(0, Math.min(lines.length, position === "after" ? line : line - 1));
	const add = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
	lines.splice(at, 0, ...add);
	return lines.join("\n");
}

/** A compact unified-style diff (changed lines with a little context), for approval dialogs and results. */
export function miniDiff(before: string, after: string, context = 2, maxLines = 40): string {
	const a = before.split("\n");
	const b = after.split("\n");
	let top = 0;
	while (top < a.length && top < b.length && a[top] === b[top]) top++;
	let ea = a.length - 1;
	let eb = b.length - 1;
	while (ea >= top && eb >= top && a[ea] === b[eb]) {
		ea--;
		eb--;
	}
	const out: string[] = [`@@ line ${top + 1} @@`];
	for (let i = Math.max(0, top - context); i < top; i++) out.push(`  ${a[i]}`);
	for (let i = top; i <= ea; i++) out.push(`- ${a[i]}`);
	for (let i = top; i <= eb; i++) out.push(`+ ${b[i]}`);
	for (let i = ea + 1; i < Math.min(a.length, ea + 1 + context); i++) out.push(`  ${a[i]}`);
	return out.length > maxLines ? [...out.slice(0, maxLines), `… (${out.length - maxLines} more diff lines)`].join("\n") : out.join("\n");
}

export interface PlannedChange {
	path: string;
	exists: boolean;
	before: string;
	after: string;
	diff: string;
	commit(): void;
}

/** Work out a change without touching the disk, so it can be shown for approval first. */
export function planEdit(path: string, edits: Edit[]): PlannedChange {
	const f = loadText(path);
	const after = applyEdits(f.body, edits);
	return { path, exists: true, before: f.body, after, diff: miniDiff(f.body, after), commit: () => saveText(path, { ...f, body: after }) };
}

/** 1-based number of the single line containing `anchor`; errors if none or several (so she quotes more). */
export function findAnchorLine(body: string, anchor: string): number {
	const needle = anchor.replace(/\r\n/g, "\n").split("\n")[0].trim();
	if (!needle) throw new Error("anchor is empty.");
	const hits: number[] = [];
	body.split("\n").forEach((l, i) => l.includes(needle) && hits.push(i + 1));
	if (!hits.length) throw new Error(`No line contains "${needle}". Copy it exactly from the file.`);
	if (hits.length > 1) throw new Error(`"${needle}" is on ${hits.length} lines (${hits.slice(0, 5).join(", ")}). Quote more of the line so it's unique.`);
	return hits[0];
}

/** Insert next to a line given by number or, more reliably, by a unique piece of its text. */
export function planInsert(path: string, line: number | { anchor: string }, text: string, position: "before" | "after"): PlannedChange {
	const f = loadText(path);
	const at = typeof line === "number" ? line : findAnchorLine(f.body, line.anchor);
	const after = insertAtLine(f.body, at, text, position);
	return { path, exists: true, before: f.body, after, diff: miniDiff(f.body, after), commit: () => saveText(path, { ...f, body: after }) };
}

export function planWrite(path: string, content: string, mode: "create" | "overwrite" | "append"): PlannedChange {
	const exists = existsSync(path);
	if (mode === "create" && exists) throw new Error("File already exists. Use edit_file / insert_text to change it, or mode \"overwrite\" if he wants it replaced.");
	if (mode !== "create" && !exists) throw new Error("File doesn't exist yet; use mode \"create\".");
	const body = content.replace(/\r\n/g, "\n");
	if (!exists) {
		return {
			path,
			exists,
			before: "",
			after: body,
			diff: miniDiff("", body),
			commit: () => {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, body);
			},
		};
	}
	const f = loadText(path);
	const after = mode === "append" ? f.body + (f.body.endsWith("\n") || !f.body ? "" : "\n") + body : body;
	return { path, exists, before: f.body, after, diff: miniDiff(f.body, after), commit: () => saveText(path, { ...f, body: after }) };
}
