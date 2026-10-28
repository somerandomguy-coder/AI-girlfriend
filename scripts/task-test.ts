// Offline tests for work mode's task board. Usage: npx tsx scripts/task-test.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MAI_HOME ??= mkdtempSync(join(tmpdir(), "mai-task-"));
const { ensureDirs } = await import("../src/core/paths.js");
ensureDirs();
const { TaskBoard } = await import("../src/core/longtask.js");

const b = new TaskBoard();
assert.equal(b.running, false);
b.start("Summarize 3 reports", ["Read a.txt", "Read b.txt", "Write summary.md"], { maxTurns: 5, maxMinutes: 10 });
assert.equal(b.running, true);
assert.deepEqual(b.nextStep(), { index: 1, text: "Read a.txt" });
assert.match(b.describe(), /\[ \] 1\. Read a\.txt/);

assert.match(b.progress({ step: 1, note: "a: revenue up 12%" }), /step 1 done\. 2 step\(s\) left/);
assert.deepEqual(b.nextStep(), { index: 2, text: "Read b.txt" });
assert.match(b.progress({ step: 9 }), /no step 9/);
b.progress({ addSteps: ["Read c.txt"] });
assert.equal(b.current!.steps.length, 4);
assert.match(b.describe(), /a: revenue up 12%/);
console.log("✓ steps, notes, added steps");

// persisted: a new board (app restart) sees the same running task
const again = new TaskBoard();
assert.equal(again.running, true);
assert.equal(again.current!.steps[0].done, true);
console.log("✓ survives a restart");

// budget: 5 turns
for (let i = 0; i < 4; i++) assert.equal(b.tick(), true);
assert.equal(b.tick(), false);
b.stop("out_of_budget");
assert.equal(b.running, false);
assert.equal(b.snapshot()!.status, "out_of_budget");
console.log("✓ turn budget stops the loop");

b.start("x", ["only step"], { maxTurns: 50, maxMinutes: 0 });
assert.equal(b.tick(), false, "deadline already passed");
b.start("y", ["s1"], { maxTurns: 50, maxMinutes: 10 });
b.progress({ step: 1, finished: true, summary: "all good" });
assert.deepEqual(b.snapshot(), { goal: "y", done: 1, total: 1, status: "done", next: undefined });
assert.equal(b.describe(), "", "no prompt section once finished");
assert.throws(() => b.progress({ step: 1 }), /No task in progress/);
console.log("✓ time budget, finishing");
console.log("all task tests passed");
