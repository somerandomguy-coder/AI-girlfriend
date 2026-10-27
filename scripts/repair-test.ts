// Offline tests for the tool-call repair parser. Usage: npx tsx scripts/repair-test.ts
import assert from "node:assert/strict";
import { coerceArgs, extractCallsFromText, matchToolName, type ToolSpec } from "../src/core/repair.js";
import { detectLang } from "../src/core/tts.js";
import { looksLikeClaim, splitMood, takeSentences } from "../src/core/brain.js";

const tools: ToolSpec[] = [
	{ name: "calendar_add", description: "", parameters: { properties: { title: { type: "string" }, start: { type: "string" }, remind_before_minutes: { type: "number" } } } },
	{ name: "move_file", description: "", parameters: { properties: { source: { type: "string" }, destination: { type: "string" } } } },
	{ name: "system_info", description: "", parameters: { properties: {} } },
];

const cases: Array<[string, string, string[]]> = [
	["fenced json", 'Ok!\n```json\n{"name": "calendar_add", "arguments": {"title": "Dentist", "start": "2026-10-28T09:00"}}\n```', ["calendar_add"]],
	["broken json (unquoted keys, trailing comma)", '```json\n{name: "calendar_add", arguments: {title: "Gym", start: "2026-10-28T18:00",}}\n```', ["calendar_add"]],
	["tool_call tags", '<tool_call>{"name":"move_file","arguments":{"source":"a","destination":"b"}}</tool_call>', ["move_file"]],
	["gemma style", "call:system_info{}", ["system_info"]],
	["openai function wrapper", '{"function": {"name": "system_info", "arguments": "{}"}}', ["system_info"]],
	["typo in name", '```json\n{"name": "calender_add", "parameters": {"title": "x", "start": "2026-10-28T09:00"}}\n```', ["calendar_add"]],
	["two calls in an array", '```json\n[{"name":"system_info","arguments":{}},{"name":"move_file","arguments":{"source":"a","destination":"b"}}]\n```', ["system_info", "move_file"]],
	["plain chat", "[happy] Good boy. Now drink water.", []],
];

for (const [label, text, expected] of cases) {
	const r = extractCallsFromText(text, tools);
	assert.deepEqual(
		r.calls.map((c) => c.name),
		expected,
		`${label}: got ${JSON.stringify(r.calls)}`,
	);
	console.log(`✓ ${label}`);
}

assert.equal(extractCallsFromText("Ok!\n```json\n{\"name\":\"system_info\",\"arguments\":{}}\n```", tools).cleanText, "Ok!");
assert.deepEqual(coerceArgs('{"remind_before_minutes": "30", "title": "x"}', tools[0]), { remind_before_minutes: 30, title: "x" });
assert.equal(matchToolName("functions.move_file", tools), "move_file");
assert.equal(matchToolName("delete_everything", tools), undefined);
assert.equal(detectLang("Em ăn cơm chưa? Đừng có nói dối chị."), "vi");
assert.equal(detectLang("what's my VRAM usage?"), "en");
assert.deepEqual(splitMood("[stern] Go to bed."), { mood: "stern", body: "Go to bed." });
assert.deepEqual(splitMood("[ste"), { body: "" });
console.log("✓ coercion, name matching, language detection, mood tags");
assert.deepEqual(splitMood("[neutral] [tender]Chào Nam."), { mood: "neutral", body: "Chào Nam." });
assert.deepEqual(splitMood("thought\n[happy] hi"), { mood: "happy", body: "hi" });
assert.deepEqual(splitMood("[happy] [ten"), { mood: "happy", body: "" });
console.log("✓ invented tags and leaked markers stripped");
assert.deepEqual(splitMood("[teasing] Đợi chút. [teasing] Xong rồi."), { mood: "teasing", body: "Đợi chút. Xong rồi." });
assert.equal(splitMood("[happy] Hi [tea").body, "Hi");
assert.equal(looksLikeClaim("Hiểu chứ, nói đi, chị đang nghe đây."), false);
assert.equal(looksLikeClaim("Your GPU is using 13.3 GB."), true);
assert.equal(looksLikeClaim("Chị đã lưu lại rồi nhé."), true);
console.log("✓ mid-text tags stripped, claim detection");
assert.deepEqual(splitMood("[stern]</body>Chào em."), { mood: "stern", body: "Chào em." });
console.log("✓ stray markup stripped");
{
	const full = "Dạ? Có chị đây, chị đang nghe đây. Your GPU uses 13.3 GB! Đi ngủ";
	const a = takeSentences(full, 0, false);
	assert.deepEqual(a.chunks, ["Dạ? Có chị đây, chị đang nghe đây.", "Your GPU uses 13.3 GB!"]);
	assert.deepEqual(takeSentences(full, a.next, true).chunks, ["Đi ngủ"]);
	assert.deepEqual(takeSentences("Ok. Hi", 0, false).chunks, []);
	assert.deepEqual(takeSentences("Ok. Hi", 0, true).chunks, ["Ok. Hi"]);
}
console.log("✓ sentence chunking for early voice");
console.log("all repair tests passed");
