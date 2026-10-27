import { randomUUID } from "node:crypto";
import { jsonrepair } from "jsonrepair";

/**
 * Tool-call repair for small local models.
 *
 * Layer 1 (cheap, deterministic): find tool calls the model wrote as *text* (fenced JSON, <tool_call> tags,
 *   Gemma-style `call:name{...}`, `name({...})`) and fix broken JSON with jsonrepair.
 * Layer 2 (needle): if the text clearly *tries* to call a tool but layer 1 can't recover it, ask the
 *   needle sidecar — a tiny grammar-constrained tool-calling model — to produce a valid call.
 */

export interface ToolSpec {
	name: string;
	description: string;
	parameters: { properties?: Record<string, { type?: string | string[] }>; required?: string[] };
}

export interface RecoveredCall {
	name: string;
	arguments: Record<string, unknown>;
	via: "text-json" | "needle";
}

function parseLoose(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		try {
			return JSON.parse(jsonrepair(text));
		} catch {
			return undefined;
		}
	}
}

function levenshtein(a: string, b: string): number {
	const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
	for (let j = 1; j <= b.length; j++) dp[0][j] = j;
	for (let i = 1; i <= a.length; i++)
		for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
	return dp[a.length][b.length];
}

export function matchToolName(name: string, tools: ToolSpec[]): string | undefined {
	const n = name.trim().replace(/^functions?\./, "").toLowerCase();
	const exact = tools.find((t) => t.name.toLowerCase() === n);
	if (exact) return exact.name;
	let best: { name: string; d: number } | undefined;
	for (const t of tools) {
		const d = levenshtein(n, t.name.toLowerCase());
		if (d <= 2 && (!best || d < best.d)) best = { name: t.name, d };
	}
	return best?.name;
}

/** Coerce argument values toward the schema ("5" -> 5, "true" -> true, object-in-a-string -> object). */
export function coerceArgs(args: unknown, spec?: ToolSpec): Record<string, unknown> {
	let obj = typeof args === "string" ? parseLoose(args) : args;
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
	obj = { ...(obj as Record<string, unknown>) };
	const props = spec?.parameters.properties ?? {};
	for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
		const types = props[k]?.type;
		const want = Array.isArray(types) ? types[0] : types;
		if (typeof v === "string") {
			if ((want === "number" || want === "integer") && v.trim() !== "" && !Number.isNaN(Number(v))) (obj as any)[k] = Number(v);
			else if (want === "boolean" && /^(true|false)$/i.test(v)) (obj as any)[k] = v.toLowerCase() === "true";
			else if ((want === "object" || want === "array") && /^[[{]/.test(v.trim())) (obj as any)[k] = parseLoose(v) ?? v;
		}
	}
	return obj as Record<string, unknown>;
}

function fromObject(o: unknown, tools: ToolSpec[]): Omit<RecoveredCall, "via"> | undefined {
	if (!o || typeof o !== "object") return undefined;
	const r = o as Record<string, any>;
	const fn = r.function && typeof r.function === "object" ? r.function : r;
	const rawName = fn.name ?? fn.tool ?? fn.tool_name ?? fn.function;
	if (typeof rawName !== "string") return undefined;
	const name = matchToolName(rawName, tools);
	if (!name) return undefined;
	const args = fn.arguments ?? fn.parameters ?? fn.args ?? fn.input ?? {};
	return { name, arguments: coerceArgs(args, tools.find((t) => t.name === name)) };
}

export interface TextExtraction {
	calls: RecoveredCall[];
	/** Text with the tool-call blobs removed (what she "said"). */
	cleanText: string;
	/** True when the text looks like a tool-call attempt, even if nothing parsed. */
	looksLikeAttempt: boolean;
}

export function extractCallsFromText(text: string, tools: ToolSpec[]): TextExtraction {
	const calls: RecoveredCall[] = [];
	let clean = text;
	const names = tools.map((t) => t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	const patterns: RegExp[] = [
		/<\|?tool_call\|?>([\s\S]*?)<\|?\/?tool_call\|?>/gi,
		/<function_call>([\s\S]*?)<\/function_call>/gi,
		/```(?:json|tool_call|tool|function)?\s*([\s\S]*?)```/gi,
	];
	for (const re of patterns) {
		clean = clean.replace(re, (whole, inner: string) => {
			const body = inner.trim().replace(/^call:/, "");
			const gemma = /^(\w+)\s*(\{[\s\S]*\})$/.exec(body);
			const parsed = gemma ? { name: gemma[1], arguments: parseLoose(gemma[2]) } : parseLoose(body);
			const list = Array.isArray(parsed) ? parsed : [parsed];
			let got = false;
			for (const item of list) {
				const c = fromObject(item, tools);
				if (c) {
					calls.push({ ...c, via: "text-json" });
					got = true;
				}
			}
			return got ? "" : whole;
		});
	}
	if (!calls.length && names) {
		// Gemma-style `call:name{...}` or python-ish `name({...})` without wrappers.
		const inline = new RegExp(`(?:call:)?\\b(${names})\\s*\\(?\\s*(\\{[\\s\\S]*?\\})\\s*\\)?`, "g");
		clean = clean.replace(inline, (whole, name: string, json: string) => {
			const c = fromObject({ name, arguments: parseLoose(json) }, tools);
			if (!c) return whole;
			calls.push({ ...c, via: "text-json" });
			return "";
		});
	}
	if (!calls.length) {
		// A bare JSON object naming a tool somewhere in the reply.
		const m = /\{[\s\S]*"(?:name|tool|function)"\s*:[\s\S]*\}/.exec(clean);
		if (m) {
			const c = fromObject(parseLoose(m[0]), tools);
			if (c) {
				calls.push({ ...c, via: "text-json" });
				clean = clean.replace(m[0], "");
			}
		}
	}
	const looksLikeAttempt =
		calls.length > 0 || /<\|?tool_call|"arguments"\s*:|"parameters"\s*:|\bcall:\w+\{/.test(text) || (names !== "" && new RegExp(`\\b(${names})\\s*\\(`).test(text));
	return { calls, cleanText: clean.replace(/\n{3,}/g, "\n\n").trim(), looksLikeAttempt };
}

/** Ask the needle sidecar to turn a messy attempt into a schema-valid call. */
export async function needleRepair(port: number, tools: ToolSpec[], userText: string, attempt: string): Promise<RecoveredCall[]> {
	const text = `${userText}\n(assistant intended: ${attempt.slice(0, 600)})`;
	const res = await fetch(`http://127.0.0.1:${port}/complete`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })), text }),
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`needle sidecar HTTP ${res.status}`);
	const out = (await res.json()) as { function_calls?: Array<{ name: string; arguments: Record<string, unknown> }>; confidence?: number };
	// Repair inputs are messy by definition, so needle's confidence runs low even on correct calls (~0.3).
	if ((out.confidence ?? 1) < 0.2) return [];
	return (out.function_calls ?? [])
		.map((c) => ({ name: matchToolName(c.name, tools) ?? "", arguments: c.arguments, via: "needle" as const }))
		.filter((c) => c.name);
}

export function toToolCallBlock(c: RecoveredCall) {
	return { type: "toolCall" as const, id: `repair_${randomUUID().slice(0, 8)}`, name: c.name, arguments: c.arguments as any };
}
