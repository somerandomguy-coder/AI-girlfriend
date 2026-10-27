// Offline tests for needs and todos. Usage: MAI_HOME=<scratch> npx tsx scripts/needs-test.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MAI_HOME ??= mkdtempSync(join(tmpdir(), "mai-needs-"));
const { ensureDirs } = await import("../src/core/paths.js");
ensureDirs();
const { Needs } = await import("../src/core/needs.js");
const { TodoList } = await import("../src/core/todos.js");

const H = 3_600_000;
const n = new Needs();
const t0 = Date.UTC(2026, 9, 28, 3); // arbitrary start
n.state = { hunger: 0, energy: 80, social: 60, fun: 60, worry: 0, updatedAt: t0, lastFedAt: 0, pokes: [] };

// 6 hours at the PC in the afternoon: hungry, lonely, bored, energy stays high, not worried
n.tick({ atPc: true, minutesOnSameApp: 20 }, t0 + 6 * H, 15);
assert.ok(n.state.hunger >= 95, `hunger ${n.state.hunger}`);
assert.ok(n.state.social <= 10, `social ${n.state.social}`);
assert.ok(n.state.fun <= 30, `fun ${n.state.fun}`);
assert.ok(n.state.energy >= 80, `energy ${n.state.energy}`);
assert.equal(n.state.worry, 0);
assert.equal(n.urgent()?.key, "hunger");
assert.match(n.describe(), /hungry.*lonely/);
console.log("✓ needs drift over an afternoon");

// feeding works once, then she's full
assert.equal(n.feed(35, t0 + 6 * H), true);
assert.ok(n.state.hunger <= 65);
n.state.hunger = 10;
assert.equal(n.feed(35, t0 + 6 * H + 5 * 60_000), false);
console.log("✓ feeding, and refusing when full");

// 2am at the PC: energy drains, worry climbs
n.tick({ atPc: true, minutesOnSameApp: 10 }, t0 + 9 * H, 2);
assert.ok(n.state.energy < 40, `energy ${n.state.energy}`);
assert.ok(n.state.worry > 20, `worry ${n.state.worry}`);
console.log("✓ late night drains energy and worries her");

// long app closure is capped (no starving overnight jump past 8h of drift)
n.state.hunger = 0;
n.tick({ atPc: false, minutesOnSameApp: 0 }, t0 + 9 * H + 48 * H, 12);
assert.ok(n.state.hunger <= 100 && n.state.hunger >= 99);
console.log("✓ big gaps are capped");

// pokes: friendly, then annoyed
const p0 = t0 + 100 * H;
assert.deepEqual([1, 2, 3, 4].map((i) => n.poke(p0 + i * 1000)), [1, 2, 3, 4]);
assert.equal(n.poke(p0 + 120_000), 1);
console.log("✓ poke counting resets after a minute");

// todos
const todos = new TodoList();
const a = todos.add({ title: "Nộp báo cáo", due: "2020-01-01", priority: "high", createdBy: "user" });
const b = todos.add({ title: "Buy milk", createdBy: "mai" });
assert.deepEqual(todos.sorted().map((t) => t.id), [a.id, b.id]);
assert.equal(todos.overdue().length, 1);
assert.equal(todos.find("milk")?.id, b.id);
todos.setDone("milk", true);
assert.deepEqual(todos.sorted().map((t) => [t.title, t.done]), [["Nộp báo cáo", false], ["Buy milk", true]]);
assert.throws(() => todos.add({ title: "x", due: "next friday", createdBy: "mai" }), /Invalid due date/);
todos.remove(a.id);
assert.match(todos.describe(), /none open/);
console.log("✓ todos: sort, overdue, find by title, done, remove, validation");
console.log("all needs/todo tests passed");
