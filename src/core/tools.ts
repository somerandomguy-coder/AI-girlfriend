import { execFile } from "node:child_process";
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Calendar } from "./calendar.js";
import { NEED_KEYS, type NeedKey, type Needs } from "./needs.js";
import type { TodoList } from "./todos.js";
import type { Config } from "./config.js";
import type { MoodEngine } from "./mood.js";
import { PERSONA_FILES, type PersonaFile, type PersonaStore } from "./persona.js";
import { isInside, type QuestBook, type QuestCheck } from "./quests.js";
import { coerceArgs, type ToolSpec } from "./repair.js";
import type { ScreenWatcher } from "./screen.js";
import { isSecretPath, readAnyFile } from "./files.js";
import { classify, runPowerShell } from "./shell.js";
import { recommendModels, systemInfo } from "./system.js";

export interface ApprovalRequest {
	kind: "powershell" | "move_file" | "read_file";
	/** One line, e.g. 'Move "cat.png" to Pictures'. */
	summary: string;
	/** Exact details he should check (command text, from/to paths). */
	detail: string;
	/** Her reason, in her words. */
	why: string;
}

export interface Services {
	cfg: Config;
	persona: PersonaStore;
	mood: MoodEngine;
	calendar: Calendar;
	todos: TodoList;
	needs: Needs;
	onPlannerChanged(): void;
	onNeedsChanged(): void;
	quests: QuestBook;
	screen: ScreenWatcher;
	/** One-shot vision question to the local model. */
	describeImage(base64Jpeg: string, question: string): Promise<string>;
	/** Called whenever persona files change, so the UI can refresh history. */
	onPersonaChanged(): void;
	/**
	 * Ask him before anything that changes his files or system. Enforced here, in code, at execution time,
	 * so no prompt or model output can skip it. Resolves false when he denies or nobody can answer.
	 */
	approve(req: ApprovalRequest): Promise<boolean>;
}

const ok = (text: string, details?: unknown) => ({ content: [{ type: "text" as const, text }], details });
const json = (o: unknown) => ok(JSON.stringify(o, null, 1), o);

/** Small models often send numbers as strings or args as a JSON string; fix before validation. */
function withCoercion<T extends ToolDefinition<any, any>>(tool: T): T {
	const spec = { name: tool.name, description: tool.description, parameters: tool.parameters as ToolSpec["parameters"] };
	return { ...tool, prepareArguments: (args: unknown) => coerceArgs(args, spec) as any };
}

const OPENABLE_APPS: Record<string, string> = {
	notepad: "notepad.exe",
	calculator: "calc.exe",
	calc: "calc.exe",
	paint: "mspaint.exe",
	explorer: "explorer.exe",
	"task manager": "taskmgr.exe",
	settings: "ms-settings:",
	spotify: "spotify:",
	"vs code": "code",
	vscode: "code",
};

export function buildTools(s: Services): ToolDefinition<TSchema, unknown>[] {
	const personaFile = Type.Union(PERSONA_FILES.map((f) => Type.Literal(f)));

	const remember = defineTool({
		name: "remember",
		label: "Remember",
		description:
			"Save a durable fact about him (file USER.md) or a note for yourself (MEMORY.md: promises, open loops to follow up, inside jokes). One short line.",
		parameters: Type.Object({
			file: Type.Union([Type.Literal("USER.md"), Type.Literal("MEMORY.md")]),
			note: Type.String({ description: "One short line, e.g. 'Has a job interview Friday 10am — ask how it went'" }),
		}),
		async execute(_id, p) {
			const v = s.persona.append(p.file as PersonaFile, p.note, `remember: ${p.note.slice(0, 60)}`, "mai");
			s.needs.adjust({ fun: 3 });
			s.onPersonaChanged();
			return ok(`Saved to ${p.file} (version ${v?.rev ?? "unchanged"}).`);
		},
	});

	const editPersona = defineTool({
		name: "edit_persona",
		label: "Edit persona",
		description:
			"Change your own personality (SOUL.md), your heartbeat checklist (HEARTBEAT.md), or fix/delete a memory. Replaces exact old_text with new_text. Every edit is versioned and he can roll it back. Use when he asks you to change, or after something important. Always give a reason.",
		parameters: Type.Object({
			file: personaFile,
			old_text: Type.String({ description: "Exact text currently in the file" }),
			new_text: Type.String({ description: "Replacement text (empty string deletes)" }),
			reason: Type.String(),
		}),
		async execute(_id, p) {
			const v = s.persona.replace(p.file as PersonaFile, p.old_text, p.new_text, p.reason, "mai");
			s.onPersonaChanged();
			return ok(`Updated ${p.file} (version ${v?.rev ?? "unchanged"}). He can roll this back from Settings → History.`);
		},
	});

	const readPersona = defineTool({
		name: "read_persona_file",
		label: "Read persona file",
		description: "Read one of your persona files in full (to quote text exactly before edit_persona).",
		parameters: Type.Object({ file: personaFile }),
		async execute(_id, p) {
			return ok(s.persona.read(p.file as PersonaFile));
		},
	});

	const calAdd = defineTool({
		name: "calendar_add",
		label: "Add to calendar",
		description: "Add an event or reminder. Convert relative times ('tomorrow 9am') to ISO using the current local time you were given.",
		parameters: Type.Object({
			title: Type.String(),
			start: Type.String({ description: "ISO 8601 local time, e.g. 2026-10-28T09:00" }),
			remind_before_minutes: Type.Optional(Type.Number({ description: "Default 15" })),
			repeat: Type.Optional(Type.Union([Type.Literal("daily"), Type.Literal("weekly")])),
			notes: Type.Optional(Type.String()),
		}),
		async execute(_id, p) {
			const e = s.calendar.add({
				title: p.title,
				start: p.start,
				remindBefore: p.remind_before_minutes ?? 15,
				repeat: p.repeat,
				notes: p.notes,
				createdBy: "mai",
			});
			s.onPlannerChanged();
			return ok(`Added "${e.title}" at ${new Date(e.start).toLocaleString()} (id ${e.id}).`);
		},
	});

	const calList = defineTool({
		name: "calendar_list",
		label: "Calendar",
		description: "List upcoming events and reminders.",
		parameters: Type.Object({ hours: Type.Optional(Type.Number({ description: "Look-ahead window, default 72" })) }),
		async execute(_id, p) {
			const list = s.calendar.upcoming(p.hours ?? 72);
			return list.length ? json(list.map((e) => ({ id: e.id, title: e.title, when: new Date(e.start).toLocaleString(), repeat: e.repeat }))) : ok("Nothing scheduled.");
		},
	});

	const calRemove = defineTool({
		name: "calendar_remove",
		label: "Remove event",
		description: "Delete an event or reminder by id.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, p) {
			const removed = s.calendar.remove(p.id);
			if (removed) s.onPlannerChanged();
			return ok(removed ? "Removed." : `No event with id ${p.id}.`);
		},
	});

	const todoAdd = defineTool({
		name: "todo_add",
		label: "Add todo",
		description: "Add an item to his todo list (shown in his 📅 planner). Use for tasks without a fixed time; use calendar_add for appointments.",
		parameters: Type.Object({
			title: Type.String(),
			due: Type.Optional(Type.String({ description: "ISO date or datetime, e.g. 2026-10-30 or 2026-10-30T17:00" })),
			priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")])),
			notes: Type.Optional(Type.String()),
		}),
		async execute(_id, p) {
			const t = s.todos.add({ title: p.title, due: p.due, priority: p.priority, notes: p.notes, createdBy: "mai" });
			s.onPlannerChanged();
			return ok(`Added todo [${t.id}] "${t.title}".`);
		},
	});

	const todoList = defineTool({
		name: "todo_list",
		label: "Todos",
		description: "List his todos (open first, plus things finished this week).",
		parameters: Type.Object({ include_done: Type.Optional(Type.Boolean()) }),
		async execute(_id, p) {
			const list = s.todos.sorted().filter((t) => p.include_done || !t.done);
			return list.length
				? json(list.map((t) => ({ id: t.id, title: t.title, due: t.due, priority: t.priority, done: t.done })))
				: ok("No todos.");
		},
	});

	const todoComplete = defineTool({
		name: "todo_complete",
		label: "Finish todo",
		description: "Mark one of his todos as done (only when he says he did it). Accepts the id or part of the title.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, p) {
			const t = s.todos.setDone(p.id, true);
			s.needs.adjust({ hunger: -15, fun: 5, worry: -5 });
			s.onPlannerChanged();
			s.onNeedsChanged();
			return ok(`Marked "${t.title}" done. (Finishing todos feeds you a little.)`);
		},
	});

	const todoRemove = defineTool({
		name: "todo_remove",
		label: "Remove todo",
		description: "Delete a todo he no longer needs (not for finished ones; use todo_complete).",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, p) {
			const t = s.todos.remove(p.id);
			s.onPlannerChanged();
			return ok(`Removed "${t.title}".`);
		},
	});

	const adjustNeeds = defineTool({
		name: "adjust_needs",
		label: "Feelings",
		description:
			"Adjust your own needs when something in the conversation affects them: he says he ate or slept (worry down), he gives you a treat (hunger down), you had fun together (fun up). Each change between -25 and 25.",
		parameters: Type.Object({
			need: Type.Union(NEED_KEYS.map((k) => Type.Literal(k))),
			change: Type.Number({ description: "-25..25" }),
			reason: Type.String(),
		}),
		async execute(_id, p) {
			const change = Math.max(-25, Math.min(25, p.change));
			s.needs.adjust({ [p.need as NeedKey]: change });
			s.onNeedsChanged();
			return ok(`${p.need} ${change >= 0 ? "+" : ""}${change} (now ${Math.round(s.needs.state[p.need as NeedKey])}).`);
		},
	});

	const questGive = defineTool({
		name: "quest_give",
		label: "Give side quest",
		description:
			"Give him a small side quest that can be verified. check_kind: file_moved (needs from,to), file_exists (path), folder_tidy (folder, max_loose_files, optional pattern like *.png), app_closed (process, e.g. 'chrome'), honor (can't be checked; you'll ask him). Use real paths from list_folder. Keep quests tiny (under 10 minutes).",
		parameters: Type.Object({
			title: Type.String(),
			pitch: Type.String({ description: "What you tell him, in character" }),
			check_kind: Type.Union(["file_moved", "file_exists", "folder_tidy", "app_closed", "honor"].map((k) => Type.Literal(k))),
			from: Type.Optional(Type.String()),
			to: Type.Optional(Type.String()),
			path: Type.Optional(Type.String()),
			folder: Type.Optional(Type.String()),
			max_loose_files: Type.Optional(Type.Number()),
			pattern: Type.Optional(Type.String()),
			process: Type.Optional(Type.String()),
			due_in_minutes: Type.Optional(Type.Number()),
			reward: Type.Optional(Type.String({ description: "What he gets, e.g. 'a headpat and my approval'" })),
		}),
		async execute(_id, p) {
			if (s.quests.active().length >= s.cfg.quests.maxActive) throw new Error("He already has enough active quests. Check those first.");
			let check: QuestCheck;
			switch (p.check_kind) {
				case "file_moved":
					if (!p.from || !p.to) throw new Error("file_moved needs from and to");
					check = { kind: "file_moved", from: p.from, to: p.to };
					break;
				case "file_exists":
					if (!p.path) throw new Error("file_exists needs path");
					check = { kind: "file_exists", path: p.path };
					break;
				case "folder_tidy":
					if (!p.folder) throw new Error("folder_tidy needs folder");
					check = { kind: "folder_tidy", folder: p.folder, maxLooseFiles: p.max_loose_files ?? 0, pattern: p.pattern };
					break;
				case "app_closed":
					if (!p.process) throw new Error("app_closed needs process");
					check = { kind: "app_closed", process: p.process };
					break;
				default:
					check = { kind: "honor" };
			}
			s.needs.adjust({ fun: 10 });
			const q = s.quests.create({ title: p.title, pitch: p.pitch, check, reward: p.reward ?? "my approval", dueInMinutes: p.due_in_minutes });
			return ok(`Quest [${q.id}] "${q.title}" is active. I'll verify it automatically when possible.`);
		},
	});

	const questCheck = defineTool({
		name: "quest_check",
		label: "Check quest",
		description: "Verify whether he completed an active side quest.",
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, p) {
			const r = s.quests.verify(p.id);
			if (r.result === "done") {
				s.mood.nudgeAffection(5);
				s.needs.adjust({ fun: 20, hunger: -10 });
			}
			if (r.result === "expired") s.mood.nudgeAffection(-3);
			return json({ quest: r.quest.title, result: r.result, detail: r.detail, reward: r.quest.reward });
		},
	});

	const questResolve = defineTool({
		name: "quest_resolve",
		label: "Resolve quest",
		description: "Mark a quest done/failed/cancelled yourself (for honor quests after he answers, or to drop one).",
		parameters: Type.Object({ id: Type.String(), status: Type.Union([Type.Literal("done"), Type.Literal("failed"), Type.Literal("cancelled")]) }),
		async execute(_id, p) {
			const q = s.quests.setStatus(p.id, p.status);
			if (p.status === "done") s.mood.nudgeAffection(4);
			return ok(`Quest "${q.title}" marked ${p.status}.`);
		},
	});

	const lookAtScreen = defineTool({
		name: "look_at_screen",
		label: "Look at screen",
		description: "Take a quick look at his screen (only if he allowed it) and get a short description of what he's doing.",
		parameters: Type.Object({ question: Type.Optional(Type.String({ description: "What you want to know, e.g. 'is he working or watching videos?'" })) }),
		async execute(_id, p) {
			const shot = await s.screen.screenshot();
			if (!shot.ok) return ok(`Can't look: ${shot.error} Current window: ${s.screen.describe()}`);
			const desc = await s.describeImage(shot.base64, p.question ?? "Briefly describe what the user is doing on this screen.");
			return ok(`What you see: ${desc}`);
		},
	});

	const sysInfo = defineTool({
		name: "system_info",
		label: "System info",
		description: "His PC status: CPU, RAM, GPU/VRAM usage, disks, battery, uptime, which AI models are loaded.",
		parameters: Type.Object({}),
		async execute() {
			return json(await systemInfo(s.cfg.ollama.baseUrl));
		},
	});

	const recommend = defineTool({
		name: "recommend_models",
		label: "Model cookbook",
		description:
			"Recommend local AI models that fit a GPU (defaults to this PC). Returns fit, quantization, VRAM needed, and estimated speed. Use for 'what model should I run' questions, or for a friend's spec.",
		parameters: Type.Object({
			vram_gb: Type.Optional(Type.Number()),
			gpu_name: Type.Optional(Type.String({ description: "e.g. 'RTX 5090'" })),
			reserve_gb: Type.Optional(Type.Number({ description: "VRAM to keep free for voice etc. Default 3" })),
			use: Type.Optional(Type.String({ description: "chat | tools | vision | agent | code" })),
		}),
		async execute(_id, p) {
			const r = recommendModels({ vramGB: p.vram_gb, gpuName: p.gpu_name, reserveGB: p.reserve_gb, use: p.use });
			return json({ ...r, results: r.results.slice(0, 6) });
		},
	});

	const listFolder = defineTool({
		name: "list_folder",
		label: "List folder",
		description: `List files in a folder (newest first). Allowed roots: ${s.cfg.allowedRoots.join(", ")}`,
		parameters: Type.Object({
			path: Type.String(),
			pattern: Type.Optional(Type.String({ description: "Filter like *.png" })),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, p) {
			if (!isInside(p.path, s.cfg.allowedRoots)) throw new Error(`Not allowed: ${p.path}`);
			const re = p.pattern ? new RegExp(`^${p.pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i") : null;
			const items = readdirSync(p.path, { withFileTypes: true })
				.filter((d) => !re || re.test(d.name))
				.map((d) => {
					const full = join(p.path, d.name);
					let st;
					try {
						st = statSync(full);
					} catch {
						return null;
					}
					return { name: d.name, dir: d.isDirectory(), sizeKB: Math.round(st.size / 1024), modified: st.mtime.toISOString().slice(0, 16) };
				})
				.filter((x): x is NonNullable<typeof x> => !!x)
				.sort((a, b) => b.modified.localeCompare(a.modified));
			return json({ path: p.path, total: items.length, items: items.slice(0, p.limit ?? 30) });
		},
	});

	const readFile = defineTool({
		name: "read_file",
		label: "Read file",
		description:
			"Read a file and get its content as text: documents (PDF, Word, Excel, PowerPoint, OpenDocument, RTF, EPUB, HTML), code/text/CSV/JSON/logs, zip archives (lists contents), and images (described by your vision; pass a question). Long files come in pages: call again with the offset it gives you. Files outside his allowed folders need his approval.",
		parameters: Type.Object({
			path: Type.String(),
			offset: Type.Optional(Type.Number({ description: "Character offset for the next page of a long file" })),
			question: Type.Optional(Type.String({ description: "For images: what you want to know" })),
		}),
		async execute(_id, p) {
			if (!existsSync(p.path)) throw new Error(`File not found: ${p.path}. Use list_folder to find the exact name.`);
			if (isSecretPath(p.path)) throw new Error("That file holds secrets or passwords; I don't open those.");
			if (!isInside(p.path, s.cfg.allowedRoots)) {
				const ok2 = await s.approve({ kind: "read_file", summary: `Read "${basename(p.path)}"`, detail: p.path, why: "It's outside the folders she's allowed to look in." });
				if (!ok2) return ok("He didn't let me read that file.");
			}
			const r = await readAnyFile(p.path, { offset: p.offset, question: p.question }, s.describeImage);
			return ok(r.text);
		},
	});

	const moveFile = defineTool({
		name: "move_file",
		label: "Move file",
		description:
			"Move a file into a folder (or to a new path). He must approve every move in a dialog, so say clearly what and why. Never overwrites. Only inside allowed roots.",
		parameters: Type.Object({
			source: Type.String(),
			destination: Type.String({ description: "Target folder or full target path" }),
			why: Type.Optional(Type.String({ description: "One short sentence for him: why move it" })),
		}),
		async execute(_id, p) {
			for (const x of [p.source, p.destination]) if (!isInside(x, s.cfg.allowedRoots)) throw new Error(`Not allowed: ${x}`);
			if (!existsSync(p.source)) throw new Error(`Source not found: ${p.source}`);
			const dest = existsSync(p.destination) && statSync(p.destination).isDirectory() ? join(p.destination, basename(p.source)) : p.destination;
			if (existsSync(dest)) throw new Error(`Destination already exists: ${dest}`);
			const approved = await s.approve({
				kind: "move_file",
				summary: `Move "${basename(p.source)}"`,
				detail: `From: ${p.source}
To:   ${dest}`,
				why: p.why ?? "She wants to tidy this up.",
			});
			if (!approved) return ok(`He did not approve moving ${basename(p.source)}. Leave it where it is unless he asks again.`);
			renameSync(p.source, dest);
			return ok(`Moved ${p.source} → ${dest}`);
		},
	});

	const openThing = defineTool({
		name: "open",
		label: "Open",
		description: `Open a website (https URL), a folder/file inside allowed roots, or an app: ${Object.keys(OPENABLE_APPS).join(", ")}.`,
		parameters: Type.Object({ target: Type.String() }),
		async execute(_id, p) {
			const t = p.target.trim();
			let launch: string;
			if (/^https?:\/\//i.test(t)) launch = t;
			else if (OPENABLE_APPS[t.toLowerCase()]) launch = OPENABLE_APPS[t.toLowerCase()];
			else if (isInside(t, s.cfg.allowedRoots) && existsSync(t)) launch = resolve(t);
			else throw new Error(`I can only open https links, allowed folders, or: ${Object.keys(OPENABLE_APPS).join(", ")}`);
			await new Promise<void>((res, rej) => execFile("cmd.exe", ["/c", "start", "", launch], { windowsHide: true }, (e) => (e ? rej(e) : res())));
			return ok(`Opened ${t}.`);
		},
	});

	const powershell = defineTool({
		name: "run_powershell",
		label: "PowerShell",
		description:
			"Run a PowerShell command on his PC and get its output. Read-only commands (Get-*, Test-*, tasklist, ipconfig…) run immediately; anything that changes something shows him the command and asks for approval first. Prefer the dedicated tools (move_file, system_info, open) when they fit. One short command; no interactive programs.",
		parameters: Type.Object({
			command: Type.String({ description: "PowerShell command, e.g. Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 Name,CPU" }),
			why: Type.String({ description: "One sentence for him explaining what this does and why" }),
		}),
		async execute(_id, p) {
			const { tier, reason } = classify(p.command);
			if (tier === "blocked") throw new Error(`Blocked for safety (${reason}). Don't retry it; tell him he has to do this himself if he really wants it.`);
			if (tier === "write" || s.cfg.shell.approval === "always") {
				const ok2 = await s.approve({ kind: "powershell", summary: "Run a PowerShell command", detail: p.command, why: p.why });
				if (!ok2) return ok("He did not approve this command. Don't run it again unless he asks.");
			}
			const r = await runPowerShell(p.command, s.cfg.shell.timeoutSeconds * 1000);
			const status = r.timedOut ? "timed out" : `exit code ${r.exitCode}`;
			return ok(`(${tier === "read" ? "read-only" : "approved"}, ${status})
${r.output}`);
		},
	});

	return [
		remember,
		editPersona,
		readPersona,
		calAdd,
		calList,
		calRemove,
		todoAdd,
		todoList,
		todoComplete,
		todoRemove,
		adjustNeeds,
		questGive,
		questCheck,
		questResolve,
		lookAtScreen,
		sysInfo,
		recommend,
		listFolder,
		readFile,
		moveFile,
		openThing,
		...(s.cfg.shell.enabled ? [powershell] : []),
	].map((t) => withCoercion(t as ToolDefinition<any, any>)) as ToolDefinition<TSchema, unknown>[];
}
