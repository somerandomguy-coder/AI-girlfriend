// Terminal client: same brain as the desktop pet, for debugging or a no-GUI setup.
// Usage: npm run tui        Commands: /wake /poke /feed /mood /needs /quests /cal /todos /history /rollback <rev> /quit
import { createInterface } from "node:readline/promises";
import { Brain, type BrainEvent } from "./core/brain.js";
import { Heartbeat } from "./core/heartbeat.js";

const c = { dim: "\x1b[2m", pink: "\x1b[38;5;211m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };

const brain = new Brain();
let streaming = false;
brain.on("event", (e: BrainEvent) => {
	switch (e.type) {
		case "delta":
			if (!streaming) process.stdout.write(`${c.pink}Mai ›${c.reset} `);
			streaming = true;
			process.stdout.write(e.text);
			break;
		case "say":
			if (streaming) process.stdout.write(`  ${c.dim}[${e.mood}]${c.reset}\n`);
			else process.stdout.write(`\n${c.pink}Mai ${e.proactive ? "(on her own) " : ""}›${c.reset} ${e.text}  ${c.dim}[${e.mood}]${c.reset}\n`);
			streaming = false;
			break;
		case "tool":
			if (e.phase === "start") process.stdout.write(`${c.dim}  ⚙ ${e.name}…${c.reset}\n`);
			else if (e.isError) process.stdout.write(`${c.red}  ✗ ${e.name} failed${c.reset}\n`);
			break;
		case "repair":
			process.stdout.write(`${c.yellow}  ↻ ${e.detail}${c.reset}\n`);
			break;
		case "error":
			process.stdout.write(`${c.red}  ! ${e.message}${c.reset}\n`);
			break;
	}
});

await brain.start();
const heartbeat = new Heartbeat(brain);
if (!process.argv.includes("--no-heartbeat")) heartbeat.start();
console.log(`${c.dim}Mai is here. Model ${brain.cfg.ollama.model}. Data: ${process.env.MAI_HOME ?? "~/.mai-companion"}. /quit to leave.${c.reset}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
let waitingForInput = false;
brain.approver = async (req) => {
	// A heartbeat run can land while the prompt is waiting for him; don't hijack that prompt.
	if (waitingForInput) return "deny";
	const a = await rl.question(`${c.yellow}  Mai asks: ${req.summary}\n  ${req.detail.replace(/\n/g, "\n  ")}\n  ("${req.why}")\n  Allow? [y = once, a = all for this request, N = no] ${c.reset}`);
	return /^y(es)?$/i.test(a.trim()) ? "once" : /^a(ll)?$/i.test(a.trim()) ? "all" : "deny";
};
for (;;) {
	waitingForInput = true;
	const line = (await rl.question("")).trim();
	waitingForInput = false;
	if (!line) continue;
	if (line === "/quit") break;
	if (line === "/wake") await heartbeat.slowTick();
	else if (line === "/mood") console.log(brain.mood.describe());
	else if (line === "/quests") console.log(brain.quests.describe());
	else if (line === "/cal") console.log(brain.calendar.describeUpcoming());
	else if (line === "/todos") console.log(brain.todos.describe());
	else if (line === "/needs") console.log(brain.needs.describe(), JSON.stringify(brain.needs.state));
	else if (line === "/poke") await brain.poke();
	else if (line === "/feed") await brain.feed();
	else if (line === "/history") for (const v of brain.persona.history(15)) console.log(`${v.rev}  ${v.date.slice(0, 16)}  [${v.author}] ${v.message}`);
	else if (line.startsWith("/rollback ")) console.log(brain.persona.rollback(line.split(" ")[1]) ? "Rolled back." : "Nothing changed.");
	else await brain.chat(line);
}
rl.close();
heartbeat.stop();
brain.dispose();
process.exit(0);
