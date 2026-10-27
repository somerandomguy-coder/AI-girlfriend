import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Calendar } from "./calendar.js";
import { type Config, loadConfig, saveConfig } from "./config.js";
import { type Mood, MoodEngine, MOODS } from "./mood.js";
import { ollamaChat, ollamaUp } from "./ollama.js";
import { ensureDirs, paths } from "./paths.js";
import { PersonaStore } from "./persona.js";
import { Needs, type NeedsState } from "./needs.js";
import { buildSystemPrompt } from "./prompt.js";
import { TodoList } from "./todos.js";
import { QuestBook } from "./quests.js";
import { extractCallsFromText, needleRepair, type ToolSpec, toToolCallBlock } from "./repair.js";
import { ScreenWatcher } from "./screen.js";
import { Sidecars } from "./sidecars.js";
import { type ApprovalRequest, buildTools, type Services } from "./tools.js";

export type ApprovalAnswer = "once" | "all" | "deny";
import { detectLang } from "./tts.js";
import { winHelper } from "./winhelper.js";

export type AvatarState = "idle" | "thinking" | "talking" | "tool" | "loading";

export type BrainEvent =
	| { type: "state"; state: AvatarState }
	| { type: "delta"; text: string }
	| { type: "say"; text: string; mood: Mood; proactive: boolean }
	/** A sentence-sized piece of what she's saying, emitted as soon as it's complete, so voice can start early. */
	| { type: "utterance"; text: string; mood: Mood }
	| { type: "tool"; name: string; phase: "start" | "end"; isError?: boolean; summary?: string }
	| { type: "mood"; mood: Mood; affection: number }
	| { type: "persona_changed" }
	| { type: "needs"; needs: NeedsState }
	| { type: "planner_changed" }
	| { type: "repair"; detail: string }
	| { type: "error"; message: string };

interface RunInfo {
	kind: "user" | "heartbeat";
	userText: string;
	toolsUsed: string[];
	autoContinues: number;
	/** Last non-empty assistant text in this run. */
	lastText: string;
	/** Text of the most recent assistant message, even if empty. */
	finalText: string;
	fabricationNudged?: boolean;
}

const SILENT = /^\s*(\[[a-z]+\]\s*)?(SILENT|HEARTBEAT_OK)\W*$/i;
const PROMISE = /\b(i'?ll|i will|let me|going to|one sec|hold on)\b|để chị|chị sẽ|đợi chị|chờ chị|chị đi/i;

/** Does a reply contain something a tool could have verified: a number, or a claim that an action was done? */
export function looksLikeClaim(text: string): boolean {
	return /\d|\b(done|saved|moved|added|scheduled|checked|deleted|removed|opened|set up|reminder set)\b|đã (lưu|chuyển|ghi|thêm|xóa|xoá|kiểm tra|mở|đặt|dọn|nhắc)|xong rồi/i.test(text);
}

/** Splits a leading [mood] tag off text; tolerant of a tag that's still streaming in. */
export function splitMood(text: string): { mood?: Mood; body: string } {
	// Gemma sometimes leaks a "thought" channel marker before the reply.
	let rest = text.replace(/^\s*thought\s*(\n|$)/i, "");
	let mood: Mood | undefined;
	// Take the first known tag; drop any extra or invented ones ("[tender]") that follow.
	for (let m = /^\s*\[([a-z]{1,12})\]\s*/i.exec(rest); m; m = /^\s*\[([a-z]{1,12})\]\s*/i.exec(rest)) {
		const tag = m[1].toLowerCase();
		if (!mood && (MOODS as readonly string[]).includes(tag)) mood = tag as Mood;
		rest = rest.slice(m[0].length);
	}
	// Gemma occasionally emits a stray markup tag ("</body>") right after the mood tag.
	rest = rest.replace(/^\s*<\/?[a-z]{1,10}>\s*/i, "");
	// Known tags can also show up mid-reply; and a tag still streaming in ("[ste") shouldn't flash on screen.
	const body = rest.replace(MID_TAG, " ").replace(/ {2,}/g, " ").replace(/\s*\[[a-z]{0,12}$/i, "");
	return mood ? { mood, body } : { body };
}
const MID_TAG = new RegExp(`\\s*\\[(${MOODS.join("|")})\\]\\s*`, "gi");

/**
 * Cut finished sentences off `body` starting at `from`. Short sentences are merged with the next one
 * (one-word chunks sound choppy). With `final`, whatever is left is returned too.
 */
export function takeSentences(body: string, from: number, final: boolean): { chunks: string[]; next: number } {
	const chunks: string[] = [];
	let start = from;
	let pending = "";
	const re = /[.!?…]+["')\]]*(?=\s)|\n+/g;
	re.lastIndex = from;
	for (let m = re.exec(body); m; m = re.exec(body)) {
		const end = m.index + m[0].length;
		pending += body.slice(start, end);
		start = end;
		if (pending.trim().length >= 12) {
			chunks.push(pending.trim());
			pending = "";
		}
	}
	if (final) {
		const rest = (pending + body.slice(start)).trim();
		if (rest) chunks.push(rest);
		return { chunks, next: body.length };
	}
	return { chunks, next: start - pending.length };
}

export class Brain extends EventEmitter {
	cfg: Config;
	readonly persona = new PersonaStore();
	mood!: MoodEngine;
	calendar!: Calendar;
	todos!: TodoList;
	needs!: Needs;
	private lastTodoCheer = 0;
	/** True while the models are being loaded into memory (she yawns meanwhile). */
	loading = true;
	quests!: QuestBook;
	screen!: ScreenWatcher;
	session!: AgentSession;
	private run?: RunInfo;
	private toolSpecs: ToolSpec[] = [];
	private sidecars!: Sidecars;
	/**
	 * Front ends set this to ask him about actions that change files or the system. Default: deny.
	 * "all" grants that kind of action for the rest of the current request only.
	 */
	approver: (req: ApprovalRequest) => Promise<ApprovalAnswer> = async () => "deny";
	private grants = new Set<ApprovalRequest["kind"]>();

	constructor() {
		super();
		ensureDirs();
		this.cfg = loadConfig();
	}

	emitEvent(e: BrainEvent): void {
		this.emit("event", e);
	}

	get busy(): boolean {
		return this.session?.isStreaming ?? false;
	}

	private services(): Services {
		return {
			cfg: this.cfg,
			persona: this.persona,
			mood: this.mood,
			calendar: this.calendar,
			todos: this.todos,
			needs: this.needs,
			onPlannerChanged: () => this.emitEvent({ type: "planner_changed" }),
			onNeedsChanged: () => this.emitEvent({ type: "needs", needs: this.needs.state }),
			quests: this.quests,
			screen: this.screen,
			describeImage: (b64, q) =>
				ollamaChat(this.cfg.ollama.baseUrl, this.cfg.ollama.model, [{ role: "user", content: `${q} Answer in 2 sentences.`, images: [b64] }]),
			onPersonaChanged: () => this.emitEvent({ type: "persona_changed" }),
			approve: async (req) => {
				if (this.grants.has(req.kind)) return true;
				const answer = await this.approver(req).catch(() => "deny" as const);
				if (answer === "all") this.grants.add(req.kind);
				return answer !== "deny";
			},
		};
	}

	async start(): Promise<void> {
		this.persona.init();
		this.mood = new MoodEngine();
		this.calendar = new Calendar();
		this.todos = new TodoList();
		this.needs = new Needs();
		this.quests = new QuestBook(this.cfg.allowedRoots);
		this.screen = new ScreenWatcher(this.cfg);
		this.screen.start();
		this.sidecars = new Sidecars(this.cfg);
		if (!(await ollamaUp(this.cfg.ollama.baseUrl))) throw new Error(`Ollama is not reachable at ${this.cfg.ollama.baseUrl}. Start Ollama first.`);
		await this.sidecars.start();
		for (const note of this.sidecars.notes) this.emitEvent({ type: "error", message: note });

		const o = this.cfg.ollama;
		const modelsPath = join(paths.pi, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify(
				{
					providers: {
						ollama: {
							baseUrl: `${o.baseUrl}/v1`,
							api: "openai-completions",
							apiKey: "ollama",
							compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
							// Thinking models (gemma4, qwen3.5) otherwise think at length even at thinkingLevel "off",
							// burning the token budget and sometimes ending with no reply at all.
							models: [o.model, o.smallModel].map((id) => ({
								id,
								contextWindow: o.contextWindow,
								maxTokens: 2048,
								input: ["text", "image"],
								samplingParams: o.think ? {} : { reasoning_effort: "none" },
							})),
						},
					},
				},
				null,
				2,
			),
		);
		const modelRuntime = await ModelRuntime.create({ authPath: join(paths.pi, "auth.json"), modelsPath });
		const model = modelRuntime.getModel("ollama", o.model);
		if (!model) throw new Error(`Model ${o.model} not configured`);

		const services = this.services();
		const tools = buildTools(services);
		this.toolSpecs = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as ToolSpec["parameters"] }));

		const resourceLoader = new DefaultResourceLoader({
			cwd: paths.data,
			agentDir: paths.pi,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "You are Mai.",
			appendSystemPrompt: [],
			extensionFactories: [(pi: ExtensionAPI) => this.installHooks(pi, services)],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: paths.data,
			agentDir: paths.pi,
			model,
			thinkingLevel: "off",
			modelRuntime,
			resourceLoader,
			noTools: "builtin",
			customTools: tools,
			sessionManager: SessionManager.continueRecent(paths.data, paths.sessions),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: true, reserveTokens: 2500, keepRecentTokens: 5000 },
				retry: { enabled: true, maxRetries: 4, baseDelayMs: 1500 },
			}),
		});
		this.session = session;
		await session.bindExtensions?.({});
		this.wireEvents();
		await this.warmUp();
	}

	/** pi extension hooks: dynamic prompt, tool-call repair, and the don't-stop-halfway goal check. */
	private installHooks(pi: ExtensionAPI, s: Services): void {
		pi.on("before_agent_start", () => ({ systemPrompt: buildSystemPrompt(s) }));

		pi.on("message_end", async (event) => {
			const msg = event.message as any;
			if (msg.role !== "assistant" || !Array.isArray(msg.content)) return;
			const hasCalls = msg.content.some((c: any) => c.type === "toolCall");
			const text = msg.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("");
			if (hasCalls || !text) return;
			const ex = extractCallsFromText(text, this.toolSpecs);
			let calls = ex.calls;
			if (!calls.length && ex.looksLikeAttempt && this.cfg.repair.useNeedle && this.sidecars.pythonRunning) {
				try {
					calls = await needleRepair(this.cfg.repair.needlePort, this.toolSpecs, this.run?.userText ?? "", text);
				} catch (e) {
					this.emitEvent({ type: "repair", detail: `needle failed: ${(e as Error).message}` });
				}
			}
			if (!calls.length) return;
			this.emitEvent({ type: "repair", detail: `recovered ${calls.map((c) => `${c.name} via ${c.via}`).join(", ")}` });
			const content = [...(ex.cleanText ? [{ type: "text", text: ex.cleanText }] : []), ...calls.map(toToolCallBlock)];
			return { message: { ...msg, content, stopReason: "toolUse" } };
		});

		pi.on("agent_before_settle", async (event) => {
			const run = this.run;
			if (!run || run.kind !== "user" || event.outcome !== "completed") return;
			if (run.autoContinues >= this.cfg.agent.maxAutoContinues) return;
			if (!run.finalText.trim()) {
				// Ended on a tool call or a cut-off message: he'd see nothing. Make her answer.
				run.autoContinues++;
				return {
					entries: [{ type: "custom_message" as const, customType: "goal_check", content: "[goal check] You haven't replied to him yet. Reply now, in character, with what you did.", display: false }],
					continue: true,
				};
			}
			// A 4B judge is only trustworthy on narrow questions, so it only gets two:
			//  - no tool ran at all → did she state live facts / claim actions anyway? (FABRICATED, once per run)
			//  - tools ran and her last words promise more → is there unfinished work? (CONTINUE)
			const promised = PROMISE.test(run.finalText);
			// Only replies that contain something checkable (numbers, "done/moved/saved…") can be fabricated;
			// asking the judge about plain chat produced false alarms.
			const askFabricated = !run.toolsUsed.length && !run.fabricationNudged && looksLikeClaim(run.finalText);
			if (!askFabricated && !promised) return;
			const verdict = await this.goalCheck(run).catch(() => null);
			if (!verdict) return;
			if (verdict.verdict === "FABRICATED" && !askFabricated) return;
			if (verdict.verdict !== "CONTINUE" && verdict.verdict !== "FABRICATED") return;
			if (verdict.verdict === "FABRICATED") run.fabricationNudged = true;
			run.autoContinues++;
			this.emitEvent({ type: "repair", detail: `goal check: ${verdict.verdict.toLowerCase()} (${verdict.reason})` });
			const content =
				verdict.verdict === "FABRICATED"
					? `[goal check] Your last reply stated facts or actions without using a tool (${verdict.reason}). Call the right tool now and answer him again from its result. Speak naturally in his language; do not quote or translate this note.`
					: `[goal check] His request isn't finished yet: ${verdict.reason}. Continue now by calling the tools you need — don't just say you will.`;
			return { entries: [{ type: "custom_message" as const, customType: "goal_check", content, display: false }], continue: true };
		});
	}

	/** Cheap second opinion: did the run actually finish what he asked? */
	private async goalCheck(run: RunInfo): Promise<{ verdict: "DONE" | "CONTINUE" | "BLOCKED" | "FABRICATED"; reason: string }> {
		const out = await ollamaChat(
			this.cfg.ollama.baseUrl,
			this.cfg.ollama.smallModel,
			[
				{
					role: "system",
					content: `You audit a desktop assistant. Available tools: ${this.toolSpecs.map((t) => t.name).join(", ")}.
Reply JSON {"verdict":"DONE"|"CONTINUE"|"BLOCKED"|"FABRICATED","reason":"<short>"}.
DONE = request handled, or it was just chat/feelings/opinions.
CONTINUE = assistant promised or started an action but did not complete it with tools.
FABRICATED = assistant stated live facts (hardware numbers, files, calendar entries, what is on screen) or claimed to have done an action, but the matching tool was NOT used.
BLOCKED = assistant correctly asked the user for missing info.`,
				},
				{
					role: "user",
					content: `Request: ${run.userText.slice(0, 800)}\nTools used: ${run.toolsUsed.join(", ") || "none"}\nAssistant's final reply: ${run.lastText.slice(0, 800)}`,
				},
			],
			{ format: "json", timeoutMs: 30_000 },
		);
		const parsed = JSON.parse(out);
		return { verdict: String(parsed.verdict).toUpperCase() as any, reason: String(parsed.reason ?? "") };
	}

	private wireEvents(): void {
		let streamed = "";
		let spokenUpTo = 0;
		this.session.subscribe((e) => {
			switch (e.type) {
				case "agent_start":
					this.emitEvent({ type: "state", state: "thinking" });
					break;
				case "message_start":
					streamed = "";
					spokenUpTo = 0;
					break;
				case "message_update":
					if (e.assistantMessageEvent.type === "text_delta" && this.run?.kind === "user") {
						const before = splitMood(streamed).body;
						streamed += e.assistantMessageEvent.delta;
						const { mood, body: after } = splitMood(streamed);
						if (after.length > before.length && after.startsWith(before)) {
							this.emitEvent({ type: "state", state: "talking" });
							this.emitEvent({ type: "delta", text: after.slice(before.length) });
							// Hand finished sentences to the voice while the rest is still being written.
							const { chunks, next } = takeSentences(after, spokenUpTo, false);
							spokenUpTo = next;
							for (const text of chunks) this.emitEvent({ type: "utterance", text, mood: mood ?? this.mood.state.mood });
						}
					}
					break;
				case "message_end": {
					const msg = e.message as any;
					if (msg.role !== "assistant") break;
					const text = (msg.content ?? [])
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("")
						.trim();
					if (this.run) {
						this.run.lastText = text || this.run.lastText;
						this.run.finalText = SILENT.test(text) ? "SILENT" : text;
					}
					if (!text || SILENT.test(text)) break;
					const { mood, body } = splitMood(text);
					if (mood) {
						this.mood.set(mood, 0.7);
						this.emitEvent({ type: "mood", mood, affection: this.mood.state.affection });
					}
					if (!body.trim()) break;
					const finalMood = mood ?? this.mood.state.mood;
					// Whatever wasn't voiced while streaming (all of it, for heartbeat runs which don't stream).
					const streamedBody = splitMood(streamed).body;
					const from = this.run?.kind === "user" && body.startsWith(streamedBody.slice(0, spokenUpTo)) ? spokenUpTo : 0;
					for (const t of takeSentences(body, from, true).chunks) this.emitEvent({ type: "utterance", text: t, mood: finalMood });
					this.emitEvent({ type: "say", text: body.trim(), mood: finalMood, proactive: this.run?.kind === "heartbeat" });
					break;
				}
				case "tool_execution_start":
					this.run?.toolsUsed.push(e.toolName);
					this.emitEvent({ type: "state", state: "tool" });
					this.emitEvent({ type: "tool", name: e.toolName, phase: "start" });
					break;
				case "tool_execution_end":
					this.emitEvent({ type: "tool", name: e.toolName, phase: "end", isError: (e as any).isError });
					break;
				case "agent_settled" as any:
					this.emitEvent({ type: "state", state: "idle" });
					break;
			}
		});
	}

	private stamp(): string {
		return new Date().toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
	}

	/** He said something. */
	async chat(text: string): Promise<void> {
		const { newStreakDay } = this.mood.onUserMessage();
		this.needs.onUserMessage();
		this.emitEvent({ type: "needs", needs: this.needs.state });
		this.mood.nudgeAffection(newStreakDay ? 1 : 0.2);
		// Small models drift toward one language; tell her explicitly which one he just used.
		const lang = detectLang(text) === "vi" ? "trả lời bằng tiếng Việt" : "reply in English";
		const content = `(${this.stamp()} · ${lang}) ${text}`;
		if (this.busy) {
			await this.session.prompt(content, { streamingBehavior: "followUp", expandPromptTemplates: false });
			return;
		}
		this.grants.clear();
		this.run = { kind: "user", userText: text, toolsUsed: [], autoContinues: 0, lastText: "", finalText: "" };
		try {
			await this.session.prompt(content, { expandPromptTemplates: false });
		} catch (e) {
			this.emitEvent({ type: "error", message: (e as Error).message });
		} finally {
			this.emitEvent({ type: "state", state: "idle" });
		}
	}

	/** Her own clock woke her up. Returns what she said, or null if she stayed quiet. */
	async wake(reason: string, details: string): Promise<string | null> {
		if (this.busy) return null;
		this.grants.clear();
		this.run = { kind: "heartbeat", userText: "", toolsUsed: [], autoContinues: 0, lastText: "", finalText: "" };
		try {
			await this.session.sendCustomMessage(
				{ customType: "heartbeat", content: `[HEARTBEAT ${this.stamp()}] reason: ${reason}\n${details}`, display: false },
				{ triggerTurn: true },
			);
			await this.session.waitForIdle?.();
		} catch (e) {
			this.emitEvent({ type: "error", message: (e as Error).message });
		} finally {
			this.emitEvent({ type: "state", state: "idle" });
		}
		const said = this.run?.lastText ?? "";
		return said && !SILENT.test(said) ? said : null;
	}

	/**
	 * Load both models into VRAM now, with the same context size the chat uses, so his first message
	 * isn't the slow one. She yawns while this happens.
	 */
	private async warmUp(): Promise<void> {
		this.loading = true;
		this.emitEvent({ type: "state", state: "loading" });
		const o = this.cfg.ollama;
		await Promise.allSettled([
			ollamaChat(o.baseUrl, o.model, [{ role: "user", content: "hi" }], { numPredict: 1, numCtx: o.contextWindow, timeoutMs: 180_000 }),
			ollamaChat(o.baseUrl, o.smallModel, [{ role: "user", content: "hi" }], { numPredict: 1, timeoutMs: 180_000 }),
		]);
		this.loading = false;
		this.emitEvent({ type: "state", state: "idle" });
	}

	/** Ollama unloads idle models after 5 minutes; refresh both so replies stay fast while she's running. */
	keepWarm(): void {
		const o = this.cfg.ollama;
		for (const model of [o.model, o.smallModel]) {
			void fetch(`${o.baseUrl}/api/generate`, { method: "POST", body: JSON.stringify({ model, keep_alive: "30m" }) }).catch(() => {});
		}
	}

	/** Advance her needs by the clock and what he's doing (called every minute by the heartbeat). */
	tickNeeds(): void {
		this.needs.tick({ atPc: this.screen.idleMs < 5 * 60_000, minutesOnSameApp: this.screen.minutesOnCurrentApp() });
		this.emitEvent({ type: "needs", needs: this.needs.state });
	}

	/** He poked her (👉). She always reacts, and gets annoyed if he spams it. */
	async poke(): Promise<string | null> {
		const n = this.needs.poke();
		this.emitEvent({ type: "needs", needs: this.needs.state });
		const details =
			n === 1
				? "He poked you (the 👉 button). React in one short line, in character: what does he want?"
				: n <= 3
					? `He poked you again (${n} times in a minute). One short line; a little teasing.`
					: `He keeps poking you (${n} times in a minute). Get playfully annoyed in one short line and tell him to use his words.`;
		return this.wake("poked", details);
	}

	/** He fed her (🍙). */
	async feed(): Promise<string | null> {
		const snacks = ["bánh mì", "trà sữa trân châu", "a bowl of phở", "bánh flan", "chè", "a strawberry daifuku", "xôi gà", "a cup of cà phê sữa đá"];
		const snack = snacks[Math.floor(Math.random() * snacks.length)];
		const ate = this.needs.feed();
		this.emitEvent({ type: "needs", needs: this.needs.state });
		return this.wake(
			"fed",
			ate
				? `He fed you ${snack} with the 🍙 button. React happily in 1-2 short sentences.`
				: `He tried to feed you ${snack}, but you ate recently and you're full. Refuse cutely in one line.`,
		);
	}

	/** He checked/unchecked a todo in the planner. Finishing one feeds her a little and earns a short cheer. */
	async toggleTodo(id: string, done: boolean): Promise<void> {
		const t = this.todos.setDone(id, done);
		this.emitEvent({ type: "planner_changed" });
		if (!done) return;
		this.needs.adjust({ hunger: -15, fun: 5, worry: -5 });
		this.mood.nudgeAffection(2);
		this.emitEvent({ type: "needs", needs: this.needs.state });
		if (Date.now() - this.lastTodoCheer < 2 * 60_000) return; // checking off five things shouldn't mean five speeches
		this.lastTodoCheer = Date.now();
		await this.wake("todo_done", `He just finished his todo "${t.title}" (checked it off himself). Praise him in one short line.`);
	}

	abort(): Promise<void> {
		return this.session.abort();
	}

	saveConfig(next: Config): void {
		this.cfg = next;
		saveConfig(next);
	}

	dispose(): void {
		this.screen?.stop();
		this.session?.dispose();
		this.sidecars?.dispose();
		winHelper.dispose();
	}
}
