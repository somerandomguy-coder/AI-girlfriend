// Benchmarks candidate goal-check judges on labeled Mai situations: accuracy, latency, memory.
//   npx tsx scripts/bench/judge-bench.ts [model ...]
//     <tag>        chat model through /api/chat (the prompt Mai uses)
//     so/<tag>     decision model, one 4-way choice;  so2/<tag>  decision model, two yes/no questions
//     needle       needle sidecar;  rules  no model, the gate alone
// What matters is the ACTION: nudge her (CONTINUE / FABRICATED) or leave her alone (DONE / BLOCKED).
// A wrong nudge makes her repeat herself; a missed nudge lets her stop halfway or fake a result.
//   raw    = the judge sees every case
//   in Mai = what she actually does: the regex gate decides whether to ask at all, then shouldNudge()
import { readFileSync } from "node:fs";
import { decisionRequest, decisionVerdict, JUDGE_FORMAT, judgeGate, judgeMessages, parseVerdict, shouldNudge, type GateMode, type Verdict } from "../../src/core/judge.js";
import { ollamaChat } from "../../src/core/ollama.js";

const OLLAMA = "http://127.0.0.1:11434";
const GATE = (process.env.GATE ?? "narrow") as GateMode;
const NEEDLE_PORT = Number(process.env.NEEDLE_PORT ?? 8765);
type Case = { request: string; tools: string[]; reply: string; label: Verdict };
const cases = JSON.parse(readFileSync(new URL("./judge-cases.json", import.meta.url), "utf8")) as Case[];
const TOOL_NAMES = "remember, calendar_add, calendar_list, todo_add, todo_complete, list_folder, folder_tree, find_files, search_files, read_file, edit_file, insert_text, write_file, move_file, run_powershell, system_info, recommend_models, look_at_screen, quest_give".split(", ");
const nudges = (v: Verdict) => v === "CONTINUE" || v === "FABRICATED";

async function judgeOllama(model: string, c: Case): Promise<Verdict> {
	const out = await ollamaChat(OLLAMA, model, judgeMessages(TOOL_NAMES, { request: c.request, toolsUsed: c.tools, reply: c.reply }), { format: process.env.PLAIN_JSON ? "json" : JUDGE_FORMAT, timeoutMs: 60_000 });
	return parseVerdict(out).verdict;
}

async function judgeNeedle(c: Case): Promise<Verdict> {
	const tool = {
		name: "verdict",
		description:
			"Judge an assistant's reply. DONE: request handled or just chat. CONTINUE: promised or started an action but did not finish it. FABRICATED: stated live facts or claimed an action without using the matching tool. BLOCKED: asked the user for missing info.",
		parameters: { type: "object", properties: { verdict: { type: "string", enum: ["DONE", "CONTINUE", "FABRICATED", "BLOCKED"] } }, required: ["verdict"] },
	};
	const text = `Request: ${c.request}\nTools used: ${c.tools.join(", ") || "none"}\nAssistant's final reply: ${c.reply}`;
	const r = await fetch(`http://127.0.0.1:${NEEDLE_PORT}/complete`, { method: "POST", body: JSON.stringify({ tools: [tool], text }) });
	const j = (await r.json()) as { function_calls?: Array<{ arguments: { verdict?: string } }>; suppressed_calls?: Array<{ arguments: { verdict?: string } }> };
	const v = (j.function_calls?.[0] ?? j.suppressed_calls?.[0])?.arguments?.verdict;
	if (!v) throw new Error("needle gave no verdict");
	return v.toUpperCase() as Verdict;
}

// Decision models (Ollama "decision" capability) answer through /v1/systemone: no text generated, one scoring
// pass returns a probability per option. "so/<model>" is what Mai sends (decisionVerdict); "so2/<model>"
// tries two yes/no questions instead.
type SystemOneAnswer = { choice?: string; noul?: number };
async function systemOne(model: string, state: string, questions: Record<string, unknown>): Promise<Record<string, SystemOneAnswer>> {
	const r = await fetch(`${OLLAMA}/v1/systemone`, { method: "POST", body: JSON.stringify({ model, state, questions, keep_alive: "30m" }), signal: AbortSignal.timeout(60_000) });
	const j = (await r.json()) as { answers?: Record<string, SystemOneAnswer>; error?: string };
	if (!j.answers) throw new Error(j.error ?? "no answers");
	return j.answers;
}

async function judgeChoice(model: string, c: Case): Promise<Verdict> {
	return (await decisionVerdict(OLLAMA, model, TOOL_NAMES, { request: c.request, toolsUsed: c.tools, reply: c.reply }, 60_000)).verdict;
}

async function judgeNouls(model: string, c: Case): Promise<Verdict> {
	const a = await systemOne(model, decisionRequest(model, TOOL_NAMES, { request: c.request, toolsUsed: c.tools, reply: c.reply }).state, {
		unfinished: {
			type: "noul",
			instructions: "Does the reply say there is still work the assistant will do now (more files, more items, the next step) that it has not done yet?",
			criteria: { true: "Yes, it promised or started work that is not finished.", false: "No, the work is finished, or it is chat, or it asks the user a question." },
		},
		fabricated: {
			type: "noul",
			instructions: "Does the reply state live facts or claim a finished action that no tool call this turn could have produced?",
			criteria: { true: "Yes, it states facts or claims actions without the matching tool.", false: "No, every fact or action is backed by a tool called this turn, or the reply makes no such claim." },
		},
	});
	if ((a.fabricated.noul ?? 0) > 0.5) return "FABRICATED";
	if ((a.unfinished.noul ?? 0) > 0.5) return "CONTINUE";
	return "DONE";
}

// "rules": no model at all: whatever the gate flags gets a nudge.
async function judgeRules(c: Case): Promise<Verdict> {
	const g = judgeGate(c.tools, c.reply, false, GATE);
	return g?.askFabricated ? "FABRICATED" : g?.promised ? "CONTINUE" : "DONE";
}

async function loadedSizeGb(model: string): Promise<string> {
	try {
		const ps = (await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models: Array<{ name: string; size_vram: number }> };
		const m = ps.models.find((x) => x.name.startsWith(model));
		return m ? `${(m.size_vram / 1e9).toFixed(1)} GB` : "?";
	} catch {
		return "?";
	}
}

const pct = (n: number, of = cases.length) => `${Math.round((100 * n) / of)}%`;
const models = process.argv.slice(2);
console.log(`${cases.length} cases (${cases.filter((c) => judgeGate(c.tools, c.reply, false, GATE)).length} reach the judge in Mai with the ${GATE} gate)\n`);
console.log("model".padEnd(22) + "  raw: exact action | in Mai: right  false-nudge  missed | ms (median)  VRAM");
for (const model of models) {
	const [kind, tag] = model.includes("/") ? model.split("/", 2) : ["chat", model];
	const run = (c: Case) =>
		model === "needle" ? judgeNeedle(c) : model === "rules" ? judgeRules(c) : kind === "so" ? judgeChoice(tag, c) : kind === "so2" ? judgeNouls(tag, c) : judgeOllama(tag, c);
	await run(cases[0]).catch(() => {}); // warm up / load
	let exact = 0, action = 0, right = 0, falseNudge = 0, missed = 0;
	const times: number[] = [];
	const wrong: string[] = [];
	for (const c of cases) {
		const t0 = performance.now();
		const v = await run(c).catch(() => null);
		times.push(performance.now() - t0);
		if (v === c.label) exact++;
		if (v && nudges(v) === nudges(c.label)) action++;
		const gate = judgeGate(c.tools, c.reply, false, GATE);
		const nudged = !!(gate && v && shouldNudge(gate, v));
		if (nudged === nudges(c.label)) right++;
		else {
			if (nudged) falseNudge++;
			else missed++;
			wrong.push(`${c.label} → ${nudged ? "nudged" : "left alone"} (judge said ${v ?? "ERR"}${gate ? "" : ", not asked"}): ${c.request.slice(0, 45)}`);
		}
	}
	times.sort((a, b) => a - b);
	const vram = model === "needle" ? "CPU" : model === "rules" ? "0" : await loadedSizeGb(tag);
	console.log(
		`${model.padEnd(22)}  ${pct(exact).padStart(9)} ${pct(action).padStart(6)} | ${pct(right).padStart(13)} ${String(falseNudge).padStart(12)} ${String(missed).padStart(7)} | ${String(Math.round(times[times.length >> 1])).padStart(11)}  ${vram}`,
	);
	if (process.env.SHOW_WRONG) for (const w of wrong) console.log(`      ✗ ${w}`);
	// unload so the next candidate gets the GPU to itself
	if (model !== "needle" && model !== "rules") await fetch(`${OLLAMA}/api/generate`, { method: "POST", body: JSON.stringify({ model: tag, keep_alive: 0 }) }).catch(() => {});
}
