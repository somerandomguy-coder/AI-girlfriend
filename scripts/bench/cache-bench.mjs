// Benchmarks llama-server's RAM caches (prompt cache + context checkpoints) on a Mai-like conversation.
// For each setting it starts a private Ollama server on its own port with those limits, replays the same
// turns, and reports how many prompt tokens were re-processed, the time, and the runner's RAM.
//
//   node scripts/bench/cache-bench.mjs [model]        (default: mai-brain; unload it from your Ollama first)
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const MODEL = process.argv[2] ?? "mai-brain";
// "inline": the changing "right now" block sits in the system prompt (before the history, old layout).
// "tail":   the system prompt never changes; "right now" is attached after the newest message (new layout).
const LAYOUT = process.argv[3] ?? "inline";
const ONLY = process.argv[4]; // optional: run just the settings whose name contains this
const OLLAMA = `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe`;
const SETTINGS = [
	{ name: "default (8 GB cache, 32 ckpt)", env: {} },
	{ name: "cache 1 GB, 4 ckpt", env: { LLAMA_ARG_CACHE_RAM: "1024", LLAMA_ARG_CTX_CHECKPOINTS: "4" } },
	{ name: "cache 2 GB, 4 ckpt", env: { LLAMA_ARG_CACHE_RAM: "2048", LLAMA_ARG_CTX_CHECKPOINTS: "4" } },
	{ name: "no cache, 4 ckpt", env: { LLAMA_ARG_CACHE_RAM: "0", LLAMA_ARG_CTX_CHECKPOINTS: "4" } },
	{ name: "no cache, no ckpt", env: { LLAMA_ARG_CACHE_RAM: "0", LLAMA_ARG_CTX_CHECKPOINTS: "0" } },
];

// ~2k-token persona that never changes, then a short "right now" tail that changes every turn (like Mai's).
const persona = `You are Mai, a bossy but caring companion. ${"She keeps his schedule, nags him to sleep, and helps with files and todos. ".repeat(120)}`;
const toolOutput = `Tool result: ${"file_${i}.txt  12 KB  2026-10-28 21:00\n".repeat(60)}`;

function runnerRamMb(port) {
	const out = execFileSync("powershell", ["-NoProfile", "-Command",
		`Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object { $_.CommandLine -match 'ollama' } | ForEach-Object { (Get-Process -Id $_.ProcessId).WorkingSet64 } | Measure-Object -Sum | Select-Object -ExpandProperty Sum`], { encoding: "utf8" });
	return Math.round(Number(out.trim() || 0) / 1048576);
}

async function chat(port, messages) {
	const t0 = Date.now();
	const r = await fetch(`http://127.0.0.1:${port}/api/chat`, {
		method: "POST",
		body: JSON.stringify({ model: MODEL, messages, stream: false, think: false, keep_alive: "5m", options: { num_predict: 40 } }),
	});
	const j = await r.json();
	if (j.error) throw new Error(j.error);
	return { ms: Date.now() - t0, evaluated: j.prompt_eval_count ?? 0, reply: j.message?.content ?? "" };
}

async function scenario(port) {
	const history = [];
	const rows = [];
	for (let turn = 1; turn <= 12; turn++) {
		const now = `Right now: turn ${turn}, ${new Date(Date.UTC(2026, 9, 28, 21, turn)).toISOString()}, mood teasing, needs ok.`;
		const said = turn % 4 === 0 ? `Here is what the folder tool returned:\n${toolOutput}` : `Turn ${turn}: chị ơi, kể em nghe một chuyện ngắn đi.`;
		// "append": the right-now note is stored WITH the message, so every prompt only grows at the end.
		history.push({ role: "user", content: LAYOUT === "append" ? `[${now}]\n${said}` : said });
		const messages =
			LAYOUT === "append"
				? [{ role: "system", content: persona }, ...history]
				: LAYOUT === "tail"
				? [{ role: "system", content: persona }, ...history.slice(0, -1), { ...history.at(-1), content: `${history.at(-1).content}\n\n[${now}]` }]
				: [{ role: "system", content: `${persona}\n\n${now}` }, ...history];
		const main = await chat(port, messages);
		history.push({ role: "assistant", content: main.reply });
		rows.push({ turn, kind: "main", ...main });
		if (turn % 3 === 0) {
			// a side call on the same model (vision description / judge) that evicts the chat from the slot
			const side = await chat(port, [{ role: "user", content: `Classify this reply as DONE or CONTINUE: "${main.reply.slice(0, 200)}"` }]);
			rows.push({ turn, kind: "side", ...side });
		}
	}
	return rows;
}

for (const s of SETTINGS.filter((x) => !ONLY || x.name.includes(ONLY))) {
	const port = 11500 + SETTINGS.indexOf(s);
	const srv = spawn(OLLAMA, ["serve"], { env: { ...process.env, ...s.env, OLLAMA_HOST: `127.0.0.1:${port}` }, stdio: "ignore", windowsHide: true });
	try {
		for (let i = 0; i < 60; i++) {
			try {
				if ((await fetch(`http://127.0.0.1:${port}/api/version`)).ok) break;
			} catch {}
			await sleep(500);
		}
		await chat(port, [{ role: "user", content: "hi" }]); // load the model
		const rows = await scenario(port);
		const main = rows.filter((r) => r.kind === "main" && r.turn > 1);
		const afterSide = main.filter((r) => (r.turn - 1) % 3 === 0);
		const avg = (xs, k) => Math.round(xs.reduce((a, r) => a + r[k], 0) / xs.length);
		console.log(
			`${s.name.padEnd(32)} main turns: ${String(avg(main, "evaluated")).padStart(5)} tok re-processed, ${String(avg(main, "ms")).padStart(5)} ms` +
				` | right after a side call: ${String(avg(afterSide, "evaluated")).padStart(5)} tok, ${String(avg(afterSide, "ms")).padStart(5)} ms | runner RAM ${runnerRamMb(port)} MB`,
		);
	} finally {
		execFileSync("taskkill", ["/PID", String(srv.pid), "/T", "/F"], { stdio: "ignore" });
		await sleep(3000);
	}
}
