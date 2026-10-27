import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.js";

export interface Todo {
	id: string;
	title: string;
	/** Optional ISO date or datetime. */
	due?: string;
	priority: "low" | "normal" | "high";
	notes?: string;
	done: boolean;
	createdBy: "mai" | "user";
	createdAt: number;
	doneAt?: number;
}

const FILE = () => join(paths.state, "todos.json");
const RANK = { high: 0, normal: 1, low: 2 };

/** His todo list. Both he (planner panel) and Mai (tools) can add, finish and remove items. */
export class TodoList {
	items: Todo[] = existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), "utf8")) : [];

	private save(): void {
		// Keep finished items for a week so "what did I get done?" still works.
		const weekAgo = Date.now() - 7 * 86_400_000;
		this.items = this.items.filter((t) => !t.done || (t.doneAt ?? 0) > weekAgo);
		writeFileSync(FILE(), JSON.stringify(this.items, null, 2));
	}

	add(t: { title: string; due?: string; priority?: Todo["priority"]; notes?: string; createdBy: Todo["createdBy"] }): Todo {
		const title = t.title.trim();
		if (!title) throw new Error("A todo needs a title.");
		if (t.due && Number.isNaN(Date.parse(t.due))) throw new Error(`Invalid due date "${t.due}". Use ISO like 2026-10-30 or 2026-10-30T17:00.`);
		const todo: Todo = { id: randomUUID().slice(0, 6), title, due: t.due, priority: t.priority ?? "normal", notes: t.notes, done: false, createdBy: t.createdBy, createdAt: Date.now() };
		this.items.push(todo);
		this.save();
		return todo;
	}

	find(idOrTitle: string): Todo | undefined {
		const q = idOrTitle.trim().toLowerCase();
		return this.items.find((t) => t.id === q) ?? this.items.find((t) => !t.done && t.title.toLowerCase().includes(q));
	}

	setDone(id: string, done: boolean): Todo {
		const t = this.find(id);
		if (!t) throw new Error(`No todo matching "${id}".`);
		t.done = done;
		t.doneAt = done ? Date.now() : undefined;
		this.save();
		return t;
	}

	remove(id: string): Todo {
		const t = this.find(id);
		if (!t) throw new Error(`No todo matching "${id}".`);
		this.items = this.items.filter((x) => x !== t);
		this.save();
		return t;
	}

	/** Open first (overdue → due soon → priority → oldest), then recently finished. */
	sorted(): Todo[] {
		const due = (t: Todo) => (t.due ? Date.parse(t.due) : Number.MAX_SAFE_INTEGER);
		const open = this.items.filter((t) => !t.done).sort((a, b) => due(a) - due(b) || RANK[a.priority] - RANK[b.priority] || a.createdAt - b.createdAt);
		const done = this.items.filter((t) => t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
		return [...open, ...done];
	}

	overdue(now = Date.now()): Todo[] {
		return this.items.filter((t) => !t.done && t.due && Date.parse(t.due) < now);
	}

	describe(): string {
		const open = this.sorted().filter((t) => !t.done);
		if (!open.length) return "Todos: none open.";
		const fmt = (t: Todo) => `[${t.id}] ${t.title}${t.due ? ` (due ${new Date(t.due).toLocaleString()})` : ""}${t.priority === "high" ? " !" : ""}`;
		return `Todos open (${open.length}): ${open.slice(0, 6).map(fmt).join("; ")}${open.length > 6 ? "; …" : ""}`;
	}
}
