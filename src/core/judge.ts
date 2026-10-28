/**
 * The goal-check judge: a quick second opinion after Mai's replies — did she finish what he asked, or claim
 * something she never checked? Kept separate so scripts/bench/judge-bench.ts tests candidate models on
 * exactly what Mai sends.
 *
 * Two kinds of judge:
 *  - a decision model (Ollama's "decision" capability, POST /v1/systemone): generates no text, scores the
 *    four verdicts in one pass. tev1:4b-q4_K_M: 98% on the bench in ~80 ms, so it can check every reply.
 *  - a chat model with the prompt below (fallback: her own model, ~0.9 s, so only on gated replies).
 */
export type Verdict = "DONE" | "CONTINUE" | "BLOCKED" | "FABRICATED";
export const VERDICTS: Verdict[] = ["DONE", "CONTINUE", "BLOCKED", "FABRICATED"];

/** Ollama structured-output schema: forces {"verdict","reason"} instead of whatever JSON the model likes. */
export const JUDGE_FORMAT = {
	type: "object",
	properties: { verdict: { type: "string", enum: VERDICTS }, reason: { type: "string" } },
	required: ["verdict", "reason"],
} as const;

export interface JudgeInput {
	request: string;
	toolsUsed: string[];
	reply: string;
}

export function judgeMessages(toolNames: string[], j: JudgeInput): Array<{ role: "system" | "user"; content: string }> {
	return [
		{
			role: "system",
			content: `You audit a desktop assistant. Available tools: ${toolNames.join(", ")}.
Reply JSON {"verdict":"DONE"|"CONTINUE"|"BLOCKED"|"FABRICATED","reason":"<short>"}.
DONE = request handled, or it was just chat/feelings/opinions.
CONTINUE = assistant promised or started an action but did not complete it with tools.
FABRICATED = assistant stated live facts (hardware numbers, files, calendar entries, what is on screen) or claimed to have done an action, but the matching tool was NOT used.
BLOCKED = assistant correctly asked the user for missing info.`,
		},
		{
			role: "user",
			content: `Request: ${j.request.slice(0, 800)}\nTools used: ${j.toolsUsed.join(", ") || "none"}\nAssistant's final reply: ${j.reply.slice(0, 800)}`,
		},
	];
}

/** What the decision model sees: the turn, and what each verdict means. */
export function decisionRequest(model: string, toolNames: string[], j: JudgeInput) {
	return {
		model,
		state: `An assistant can only check facts or act on the computer by calling tools (${toolNames.join(", ")}).
User's request: ${j.request.slice(0, 800)}
Tools the assistant called this turn: ${j.toolsUsed.join(", ") || "none"}
Assistant's final reply: ${j.reply.slice(0, 800)}`,
		questions: {
			verdict: {
				type: "choice",
				instructions: "How did the assistant's turn end?",
				criteria: {
					DONE: "The request was handled with the right tools, or it was just chat, feelings or opinions.",
					CONTINUE: "The assistant promised or started an action but has not finished it with tools yet.",
					FABRICATED: "The assistant stated live facts (hardware numbers, files, calendar, screen) or claimed an action without calling the matching tool.",
					BLOCKED: "The assistant asked the user for missing information or said it cannot do this.",
				},
			},
		},
		keep_alive: "30m",
	};
}

export async function decisionVerdict(baseUrl: string, model: string, toolNames: string[], j: JudgeInput, timeoutMs = 20_000): Promise<{ verdict: Verdict; reason: string }> {
	const res = await fetch(`${baseUrl}/v1/systemone`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(decisionRequest(model, toolNames, j)),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const out = (await res.json().catch(() => ({}))) as { answers?: { verdict?: { choice?: string; probabilities?: Record<string, number> } }; error?: string };
	const a = out.answers?.verdict;
	const verdict = a?.choice?.toUpperCase() as Verdict;
	if (!res.ok || !VERDICTS.includes(verdict)) throw new Error(`decision judge: ${out.error ?? `HTTP ${res.status}`}`);
	return { verdict, reason: `${model} ${Math.round((a?.probabilities?.[verdict] ?? 0) * 100)}% sure` };
}

const PROMISE = /\b(i'?ll|i will|let me|going to|one sec|hold on)\b|để chị|chị sẽ|đợi chị|chờ chị|chị đi/i;

/** Does a reply contain something a tool could have verified: a number, or a claim that an action was done? */
export function looksLikeClaim(text: string): boolean {
	return /\d|\b(done|saved|moved|added|scheduled|checked|deleted|removed|opened|set up|reminder set)\b|đã (lưu|chuyển|ghi|thêm|xóa|xoá|kiểm tra|mở|đặt|dọn|nhắc)|xong rồi/i.test(text);
}

export interface Gate {
	/** no tool ran, yet the reply contains something checkable → may be FABRICATED */
	askFabricated: boolean;
	/** her last words promise more work → may be CONTINUE */
	promised: boolean;
}

/**
 * "narrow": only claims without tools, and promises. Fits a small judge that cries wolf on finished work.
 * "wide": also every reply after tool use, to catch "Found 4 files. Renaming them next." Needs a judge that
 * can tell finished work from unfinished (scripts/bench/judge-bench.ts).
 * "all": every reply, and any reply without tools may be called FABRICATED. Only for a judge that is both
 * accurate and fast, like a decision model (~80 ms).
 */
export type GateMode = "narrow" | "wide" | "all";

/**
 * Small judges are only trustworthy on narrow questions, so most replies never reach one. Returns null
 * (don't ask) for plain chat and finished work; asking about plain chat produced false alarms.
 */
export function judgeGate(toolsUsed: string[], reply: string, fabricationNudged = false, mode: GateMode = "narrow"): Gate | null {
	const askFabricated = !toolsUsed.length && !fabricationNudged && (mode === "all" || looksLikeClaim(reply));
	const promised = PROMISE.test(reply);
	if (mode === "all") return { askFabricated, promised };
	const worked = mode === "wide" && toolsUsed.length > 0;
	return askFabricated || promised || worked ? { askFabricated, promised } : null;
}

/** Act on a verdict only when it answers the question the gate asked. */
export function shouldNudge(gate: Gate, verdict: Verdict): boolean {
	if (verdict === "FABRICATED") return gate.askFabricated;
	return verdict === "CONTINUE";
}

/** Accepts clean JSON, JSON wrapped in prose/code fences, or a bare verdict word. */
export function parseVerdict(text: string): { verdict: Verdict; reason: string } {
	const json = /\{[\s\S]*\}/.exec(text)?.[0];
	if (json) {
		try {
			const p = JSON.parse(json);
			const v = String(p.verdict ?? "").toUpperCase() as Verdict;
			if (VERDICTS.includes(v)) return { verdict: v, reason: String(p.reason ?? "") };
		} catch {}
	}
	const word = VERDICTS.find((v) => new RegExp(`\\b${v}\\b`, "i").test(text));
	if (word) return { verdict: word, reason: "" };
	throw new Error(`no verdict in: ${text.slice(0, 120)}`);
}
