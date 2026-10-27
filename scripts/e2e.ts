// End-to-end check of the brain against the real Ollama model, in a throwaway MAI_HOME.
// Usage: MAI_HOME=/tmp/mai-e2e npx tsx scripts/e2e.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OfficeGenerator, OfficeParser } from "officeparser";
import { Brain, type BrainEvent } from "../src/core/brain.js";

const home = process.env.MAI_HOME;
if (!home) throw new Error("Set MAI_HOME to a scratch folder");
const sandbox = join(home, "sandbox");
mkdirSync(join(sandbox, "Downloads"), { recursive: true });
mkdirSync(join(sandbox, "Pictures"), { recursive: true });
for (const f of ["Screenshot 2026-10-20.png", "Screenshot 2026-10-21.png", "notes.txt"]) writeFileSync(join(sandbox, "Downloads", f), "x");

{
	const md = [
		"# Hợp đồng thuê nhà",
		"Tiền thuê: **5.500.000đ/tháng**, đóng trước ngày 5 hằng tháng.",
		"Đặt cọc 2 tháng. Hợp đồng hết hạn ngày 31/03/2027.",
		"Không được nuôi thú cưng.",
	].join("\n\n");
	const ast = await OfficeParser.parseOffice(Buffer.from(md), { fileType: "md" } as any);
	writeFileSync(join(sandbox, "Downloads", "hop-dong.docx"), Buffer.from(((await OfficeGenerator.generate(ast as any, "docx" as any)) as any).value));
}
const brain = new Brain();
brain.cfg.allowedRoots = [sandbox];
brain.cfg.userName = "Nam";
brain.cfg.tts.vieneu.autostart = false; // the brain test doesn't need the voice server
// Moves are approved (so the file step still works); PowerShell writes are denied.
brain.approver = async (req) => {
	const answer = req.kind === "move_file" ? "all" : "deny";
	console.log(`APPROVAL ASKED (${answer}): ${req.summary} :: ${req.detail.replace(/\s+/g, " ")}`);
	return answer;
};
const log: string[] = [];
brain.on("event", (e: BrainEvent) => {
	if (e.type === "delta" || e.type === "state") return;
	const line = e.type === "say" ? `SAY[${e.mood}${e.proactive ? ",proactive" : ""}] ${e.text}` : `${e.type.toUpperCase()} ${JSON.stringify(e)}`;
	log.push(line);
	console.log(line);
});
await brain.start();

const steps: Array<[string, () => Promise<unknown>]> = [
	["greeting (vi)", () => brain.chat("Chào chị, em là Nam. Em vừa đi làm về, mệt quá.")],
	["pure chat (must NOT trigger a fabrication nudge)", () => brain.chat("em hiểu anh nói gì hong")],
	["live fact, english (must call system_info, reply in English)", () => brain.chat("hi Mai, what's my PC's VRAM usage right now?")],
	["remember fact", () => brain.chat("Btw I have a job interview this Friday at 10am, please remember that.")],
	["calendar", () => brain.chat("Remind me to call mom tomorrow at 8pm.")],
	["files", () => brain.chat(`Can you move all the screenshots from ${join(sandbox, "Downloads")} into ${join(sandbox, "Pictures")}?`)],
	["powershell read-only (runs without asking)", () => brain.chat("Which 3 programs are using the most memory on my PC right now?")],
	["powershell write (approval denied in this test)", () => brain.chat("Use PowerShell to create a folder called MaiTest in my Documents.")],
	["read a Word file", () => brain.chat(`Đọc giúp em file hop-dong.docx trong ${join(sandbox, "Downloads")} rồi tóm tắt: tiền thuê bao nhiêu, hết hạn khi nào?`)],
	["todo via chat", () => brain.chat("Thêm vào todo giúp em: nộp báo cáo trước 5 giờ chiều thứ Sáu.")],
	["todo finished via chat", () => brain.chat("Em nộp báo cáo xong rồi nhé!")],
	["poke", () => brain.poke()],
	["poke spam", async () => { await brain.poke(); await brain.poke(); await brain.poke(); }],
	["feed", () => brain.feed()],
	["cookbook", () => brain.chat("My friend has an RTX 5090 with 32GB VRAM. Which local model should he run for you?")],
	["persona edit", () => brain.chat("From now on, call me 'nhóc' more often. Update your personality so you remember.")],
	["heartbeat", () => brain.wake("check_in", "Spontaneous moment: Give him a tiny side quest that tidies his PC. Use list_folder to find something real, then quest_give.")],
];
for (const [name, fn] of steps) {
	console.log(`\n=== ${name} ===`);
	const t0 = Date.now();
	await fn();
	console.log(`--- ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
console.log("\n=== persona history ===");
for (const v of brain.persona.history(10)) console.log(`${v.rev} [${v.author}] ${v.message}`);
console.log("\n=== state ===");
console.log(brain.calendar.describeUpcoming());
console.log(brain.quests.describe());
console.log(brain.mood.describe());
console.log(brain.needs.describe());
console.log(brain.todos.describe(), JSON.stringify(brain.todos.sorted().map((t) => [t.title, t.due, t.done])));
brain.dispose();
process.exit(0);
