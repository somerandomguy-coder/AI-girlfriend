// Real-model check of exploring, precise editing, and work mode (a long task looped to completion).
// Usage: $env:MAI_HOME="$env:TEMP\mai-work"; npx tsx scripts/work-e2e.ts      (needs Ollama)
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Brain, type BrainEvent } from "../src/core/brain.js";

const home = process.env.MAI_HOME;
if (!home) throw new Error("Set MAI_HOME to a scratch folder");
const box = join(home, "sandbox");
rmSync(box, { recursive: true, force: true });
mkdirSync(join(box, "reports"), { recursive: true });
mkdirSync(join(box, "app", "node_modules", "junk"), { recursive: true });
writeFileSync(join(box, "notes.md"), "# Việc cần làm\n- mua sữa\n- gọi mẹ\n- nộp báo cáo\n");
writeFileSync(join(box, "app", "node_modules", "junk", "interview.md"), "interview (must be skipped)\n");
writeFileSync(join(box, "app", "plan.md"), "Prepare for the job interview on Friday.\n");
const reports = [
	["01-sales.txt", "Doanh thu tháng 9: 120 triệu, tăng 12%."],
	["02-costs.txt", "Chi phí tháng 9: 80 triệu, giảm 5%."],
	["03-staff.txt", "Nhân sự: tuyển thêm 2 người, nghỉ việc 1 người."],
	["04-customers.txt", "Khách hàng mới: 35, khách hàng quay lại: 60%."],
	["05-risks.txt", "Rủi ro: nhà cung cấp giao hàng trễ 2 tuần."],
	["06-plan.txt", "Kế hoạch tháng 10: mở thêm kênh bán online."],
];
for (const [name, body] of reports) writeFileSync(join(box, "reports", name), body + "\n");

const brain = new Brain();
brain.cfg.allowedRoots = [box];
brain.cfg.tts.vieneu.autostart = false;
brain.cfg.heartbeat.enabled = false;
const asked: string[] = [];
brain.approver = async (req) => {
	asked.push(req.kind);
	console.log(`  APPROVE ${req.kind}: ${req.summary}`);
	return req.kind === "long_task" ? "once" : "all";
};
const tools: string[] = [];
brain.on("event", (e: BrainEvent) => {
	if (e.type === "tool" && e.phase === "start") tools.push(e.name);
	if (e.type === "say") console.log(`  SAY ${e.text.replace(/\s+/g, " ").slice(0, 180)}`);
	if (e.type === "task" && e.task) console.log(`  TASK ${e.task.status} ${e.task.done}/${e.task.total}`);
	if (e.type === "repair") console.log(`  REPAIR ${e.detail}`);
});
await brain.start();

async function step(name: string, fn: () => Promise<unknown>) {
	tools.length = 0;
	const t0 = Date.now();
	console.log(`\n=== ${name}`);
	await fn();
	console.log(`  tools: ${tools.join(", ")} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

await step("explore: find + search, skipping node_modules", () =>
	brain.chat(`Trong thư mục ${box}, file nào nhắc đến "interview"? Tìm giúp em.`),
);
assert.ok(tools.some((t) => t === "search_files" || t === "find_files"), "used an explore tool");

await step("precise edit + insert", () =>
	brain.chat(`Trong file ${join(box, "notes.md")}: đổi "mua sữa" thành "mua sữa tươi", và thêm dòng "- đi chợ" ngay sau dòng "- gọi mẹ".`),
);
const notes = readFileSync(join(box, "notes.md"), "utf8");
console.log(`  notes.md now:\n${notes.replace(/^/gm, "    ")}`);
assert.match(notes, /- mua sữa tươi\n/);
assert.match(notes, /- gọi mẹ\n- đi chợ\n/);
assert.match(notes, /- nộp báo cáo/, "the rest of the file is intact");
assert.ok(readdirSync(join(home, "state", "backups")).length >= 1, "a backup was made");

await step("long task: read 6 files one by one, write a summary", () =>
	brain.chat(
		`Em có 6 file báo cáo trong ${join(box, "reports")}. Đọc từng file một (đừng bỏ file nào), rồi viết file ${join(box, "summary.md")} với mỗi file một dòng tóm tắt. Việc này hơi dài, chị cứ làm từ từ.`,
	),
);
// If the loop ended early (errors), the heartbeat would resume it; emulate that here.
for (let i = 0; i < 3 && brain.tasks.running; i++) await brain.resumeTask();
const task = brain.tasks.current;
console.log(`  task: ${task?.status}, ${task?.steps.filter((s) => s.done).length}/${task?.steps.length} steps, ${task?.turns} turns`);
assert.ok(asked.includes("long_task"), "asked permission for the long task");
assert.ok(existsSync(join(box, "summary.md")), "summary.md written");
const summary = readFileSync(join(box, "summary.md"), "utf8");
console.log(`  summary.md:\n${summary.replace(/^/gm, "    ")}`);
// One fact per report; she may paraphrase ("chậm" for "trễ"), so each fact has a few acceptable spellings.
const facts = [["120"], ["80"], ["2 người", "tuyển", "nhân sự"], ["35"], ["trễ", "chậm", "2 tuần"], ["online"]];
const covered = facts.filter((alts) => alts.some((k) => summary.toLowerCase().includes(k.toLowerCase()))).map((a) => a[0]);
console.log(`  facts covered: ${covered.length}/6 (${covered.join(", ")})`);
assert.ok(covered.length >= 5, "summary covers the files");
assert.equal(task?.status, "done");

// The loop itself: one step per reply, so only work mode's auto-continue can carry her to the end.
await step("work-mode loop: one step per message, auto-continued to the end", async () => {
	brain.tasks.start(
		"Ghi chú từng báo cáo vào notes-per-file.md",
		reports.map(([name]) => `Đọc ${join(box, "reports", name)} rồi thêm (write_file mode append) một dòng tóm tắt vào ${join(box, "notes-per-file.md")}`),
		{ maxTurns: 40, maxMinutes: 20 },
	);
	await brain.chat("Bắt đầu đi chị. Mỗi lần chỉ làm ĐÚNG MỘT bước, xong bước đó thì gọi task_progress, nói một câu ngắn rồi dừng.");
	for (let i = 0; i < 3 && brain.tasks.running; i++) await brain.resumeTask();
});
const loop = brain.tasks.current!;
const perFile = existsSync(join(box, "notes-per-file.md")) ? readFileSync(join(box, "notes-per-file.md"), "utf8").trim().split("\n").filter(Boolean) : [];
console.log(`  loop task: ${loop.status}, ${loop.steps.filter((s) => s.done).length}/${loop.steps.length} steps, ${loop.turns} auto-continued turns, ${perFile.length} lines written`);
assert.ok(loop.turns >= 2, "work mode had to continue her at least twice");
assert.equal(loop.status, "done");
assert.ok(perFile.length >= 5, "one line per report");
console.log("\nwork e2e passed");
brain.dispose();
process.exit(0);
