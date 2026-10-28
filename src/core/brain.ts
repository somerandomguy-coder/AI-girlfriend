import { EventEmitter } from "node:events";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { decisionVerdict, JUDGE_FORMAT, judgeGate, judgeMessages, parseVerdict, shouldNudge, type Verdict } from "./judge.js";
export { looksLikeClaim } from "./judge.js";
import { Needs, type NeedsState } from "./needs.js";
import { buildNowNote, buildSystemPrompt, withNowNote } from "./prompt.js";
import { TodoList } from "./todos.js";
import { TaskBoard } from "./longtask.js";
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
	| { type: "task"; task: ReturnType<TaskBoard["snapshot"]> }
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
	/** He said no to an approval in this run: what's left is his call, so the goal check stays quiet. */
	denied?: boolean;
}

const SILENT = /^\s*(\[[a-z]+\]\s*)?(SILENT|HEARTBEAT_OK)\W*$/i;
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
	tasks!: TaskBoard;
	needs!: Needs;
	private lastTodoCheer = 0;
	/** Work mode stall detection: tools run since the last continuation, and continuations in a row without any. */
	private workToolsThisTurn = 0;
	private workIdleTurns = 0;
	/** Set once the decision-model judge fails; from then on her own model judges (see goalCheck). */
	private decisionJudgeFailed = false;
	/** True while the models are being loaded into memory (she yawns meanwhile). */
	loading = true;
	quests!: QuestBook;
	screen!: ScreenWatcher;
	session!: AgentSession;
	private run?: RunInfo;
	private toolSpecs: ToolSpec[] = [];
	private sidecars!: Sidecars;
	private modelRuntime?: ModelRuntime;
	private resourceLoader?: DefaultResourceLoader;
	private customTools: any[] = [];
	private startPromise?: Promise<void>;
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
		const self = this;
		return {
			get cfg() {
				return self.cfg;
			},
			persona: this.persona,
			mood: this.mood,
			calendar: this.calendar,
			todos: this.todos,
			get tasks() {
				return self.tasks;
			},
			onTaskChanged: () => this.emitEvent({ type: "task", task: this.tasks.snapshot() }),
			needs: this.needs,
			onPlannerChanged: () => this.emitEvent({ type: "planner_changed" }),
			onNeedsChanged: () => this.emitEvent({ type: "needs", needs: this.needs.state }),
			get quests() {
				return self.quests;
			},
			screen: this.screen,
			describeImage: (b64, q) =>
				ollamaChat(self.cfg.ollama.baseUrl, self.cfg.ollama.model, [{ role: "user", content: `${q} Answer in 2 sentences.`, images: [b64] }]),
			onPersonaChanged: () => this.emitEvent({ type: "persona_changed" }),
			approve: async (req) => {
				if (this.grants.has(req.kind)) return true;
				const answer = await this.approver(req).catch(() => "deny" as const);
				if (answer === "all") this.grants.add(req.kind);
				if (answer === "deny" && this.run) this.run.denied = true;
				return answer !== "deny";
			},
		};
	}

	start(): Promise<void> {
		this.startPromise = this.doStart();
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		this.persona.init();
		this.mood = new MoodEngine();
		this.calendar = new Calendar();
		this.todos = new TodoList();
		this.tasks = new TaskBoard();
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
							models: [o.model].map((id) => ({
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

		this.modelRuntime = modelRuntime;
		this.resourceLoader = resourceLoader;
		this.customTools = tools;
		await this.initSession();
		await this.warmUp();
	}

	private async initSession(): Promise<void> {
		const o = this.cfg.ollama;
		const model = this.modelRuntime?.getModel("ollama", o.model);
		if (!model) throw new Error(`Model ${o.model} not configured`);

		let session: AgentSession;
		try {
			const res = await createAgentSession({
				cwd: paths.data,
				agentDir: paths.pi,
				model,
				thinkingLevel: "off",
				modelRuntime: this.modelRuntime!,
				resourceLoader: this.resourceLoader!,
				noTools: "builtin",
				customTools: this.customTools,
				sessionManager: SessionManager.continueRecent(paths.data, paths.sessions),
				settingsManager: SettingsManager.inMemory({
					compaction: { enabled: true, reserveTokens: 4500, keepRecentTokens: 4000 },
					retry: { enabled: true, maxRetries: 4, baseDelayMs: 1500 },
				}),
			});
			session = res.session;
		} catch (err) {
			try {
				if (existsSync(paths.sessions)) {
					for (const f of readdirSync(paths.sessions)) {
						rmSync(join(paths.sessions, f), { recursive: true, force: true });
					}
				}
			} catch {}
			const res = await createAgentSession({
				cwd: paths.data,
				agentDir: paths.pi,
				model,
				thinkingLevel: "off",
				modelRuntime: this.modelRuntime!,
				resourceLoader: this.resourceLoader!,
				noTools: "builtin",
				customTools: this.customTools,
				sessionManager: SessionManager.continueRecent(paths.data, paths.sessions),
				settingsManager: SettingsManager.inMemory({
					compaction: { enabled: true, reserveTokens: 4500, keepRecentTokens: 4000 },
					retry: { enabled: true, maxRetries: 4, baseDelayMs: 1500 },
				}),
			});
			session = res.session;
		}
		this.session = session;
		await session.bindExtensions?.({});
		this.wireEvents();
	}

	/** Resets conversation context and active session files while preserving persistent persona / MEMORY.md. */
	async resetSession(): Promise<void> {
		if (this.session) {
			try {
				await this.session.abort();
			} catch {}
			try {
				this.session.dispose();
			} catch {}
		}
		if (existsSync(paths.sessions)) {
			try {
				for (const f of readdirSync(paths.sessions)) {
					rmSync(join(paths.sessions, f), { recursive: true, force: true });
				}
			} catch {}
		}
		this.grants.clear();
		this.run = undefined;
		if (this.modelRuntime && this.resourceLoader) {
			await this.initSession();
		}
	}

	/** pi extension hooks: dynamic prompt, tool-call repair, and the don't-stop-halfway goal check. */
	private installHooks(pi: ExtensionAPI, s: Services): void {
		// The note is fixed for the whole run so every tool-loop call shares the same cached prefix.
		let nowNote = "";
		pi.on("before_agent_start", () => {
			nowNote = buildNowNote(s);
			return { systemPrompt: buildSystemPrompt(s) };
		});
		pi.on("context", (event) => ({ messages: withNowNote(event.messages, nowNote) }));

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
			if (this.tasks?.running && event.outcome === "completed") {
				// A long task keeps one run going for many turns, and pi only compacts when a run starts, so
				// work mode watches the context itself: past ~65% of the window (or after a turn that ran out
				// of room), everything but the last few turns is replaced by the task's own goal/checklist/notes.
				const compaction = this.workModeCompaction(event.context);
				const custom = (content: string) => ({
					entries: [...(compaction ? [compaction] : []), { type: "custom_message" as const, customType: "work_mode", content, display: false }],
					continue: true,
				});
				// No tool used across several continuations = she's spinning, not working.
				if (this.tasks.current!.turns === 0) this.workIdleTurns = 0; // a fresh task starts with a clean slate
				this.workIdleTurns = this.workToolsThisTurn ? 0 : this.workIdleTurns + 1;
				this.workToolsThisTurn = 0;
				if (this.workIdleTurns >= 3) {
					this.workIdleTurns = 0;
					const stuck = this.tasks.nextStep();
					this.tasks.progress({ note: `Got stuck on step ${stuck?.index ?? "?"}; paused for his input.` });
					this.tasks.stop("stopped");
					this.emitEvent({ type: "task", task: this.tasks.snapshot() });
					return custom(`[work mode] You haven't made progress for a few turns, so the task is paused. Tell him in one or two lines what's done and what's blocking step ${stuck?.index ?? ""}.`);
				}
				if (!this.tasks.tick()) {
					this.tasks.stop("out_of_budget");
					this.emitEvent({ type: "task", task: this.tasks.snapshot() });
					return custom("[work mode] The time/turn budget for this task is used up. Stop working now and tell him briefly what's done and what's left.");
				}
				this.emitEvent({ type: "task", task: this.tasks.snapshot() });
				const next = this.tasks.nextStep();
				return custom(
					next
						? `[work mode] Keep going: step ${next.index} — ${next.text}. Use your tools, then call task_progress.`
						: "[work mode] All steps are checked. If the goal is really met, call task_progress with finished=true and a summary for him; otherwise add the missing steps.",
				);
			}
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
			if (run.denied) return;
			const gate = judgeGate(run.toolsUsed, run.finalText, run.fabricationNudged, this.decisionJudgeOk() ? "all" : "wide");
			if (!gate) return;
			const verdict = await this.goalCheck(run).catch(() => null);
			if (!verdict || !shouldNudge(gate, verdict.verdict)) return;
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

	/** The decision-model judge is configured and hasn't failed (not pulled, Ollama too old). */
	private decisionJudgeOk(): boolean {
		return !!this.cfg.ollama.judgeModel && !this.decisionJudgeFailed;
	}

	/** Cheap second opinion: did the run actually finish what he asked? */
	private async goalCheck(run: RunInfo): Promise<{ verdict: Verdict; reason: string }> {
		const o = this.cfg.ollama;
		const tools = this.toolSpecs.map((t) => t.name);
		const turn = { request: run.userText, toolsUsed: run.toolsUsed, reply: run.lastText };
		if (this.decisionJudgeOk()) {
			try {
				return await decisionVerdict(o.baseUrl, o.judgeModel, tools, turn);
			} catch (e) {
				this.decisionJudgeFailed = true;
				this.emitEvent({ type: "repair", detail: `goal-check model ${o.judgeModel} unavailable, her own model judges instead: ${(e as Error).message}` });
			}
		}
		const out = await ollamaChat(o.baseUrl, o.model, judgeMessages(tools, turn), { format: JUDGE_FORMAT, timeoutMs: 30_000 });
		return parseVerdict(out);
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
					this.workToolsThisTurn++;
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
		if (this.startPromise) {
			try {
				await this.startPromise;
			} catch (e) {
				this.emitEvent({ type: "error", message: `Mai is not connected to Ollama: ${(e as Error).message}` });
				return;
			}
		}
		if (!this.session) {
			this.emitEvent({ type: "error", message: "Mai's brain is still waking up. Please wait a moment." });
			return;
		}
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
		if (this.busy || !this.session) return null;
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
			ollamaChat(o.baseUrl, o.model, [{ role: "user", content: "hi" }], { numPredict: 1, timeoutMs: 180_000 }),
			this.pingJudge(180_000),
		]);
		this.loading = false;
		this.emitEvent({ type: "state", state: "idle" });
	}

	/** Ollama unloads idle models after 5 minutes; refresh both so replies stay fast while she's running. */
	keepWarm(): void {
		const o = this.cfg.ollama;
		void fetch(`${o.baseUrl}/api/generate`, { method: "POST", body: JSON.stringify({ model: o.model, keep_alive: "30m" }) }).catch(() => {});
		void this.pingJudge(30_000);
	}

	/** Decision models can't /api/generate; a tiny real question loads them (and finds out early if one is missing). */
	private async pingJudge(timeoutMs: number): Promise<void> {
		if (!this.decisionJudgeOk()) return;
		const o = this.cfg.ollama;
		try {
			await decisionVerdict(o.baseUrl, o.judgeModel, [], { request: "hi", toolsUsed: [], reply: "hi" }, timeoutMs);
		} catch (e) {
			this.decisionJudgeFailed = true;
			this.emitEvent({ type: "repair", detail: `goal-check model ${o.judgeModel} unavailable, her own model judges instead: ${(e as Error).message}` });
		}
	}

	/**
	 * Work-mode compaction: if the conversation is close to filling the context window, return a compaction
	 * entry that keeps only the last few turns and summarizes the rest with the task board (goal, checked
	 * steps, her notes). Returns null when there's room.
	 */
	private workModeCompaction(ctx: { contextEntries: Array<{ sourceEntry: { id: string }; messages: any[] }>; contextMessages: any[] }) {
		const last = [...ctx.contextMessages].reverse().find((m) => m.role === "assistant");
		const u = last?.usage ?? {};
		const used = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
		const ranOutOfRoom = last?.stopReason === "length" && !(last.content ?? []).some((c: any) => c.type === "toolCall" || (c.type === "text" && c.text.trim()));
		if (!ranOutOfRoom && used < this.cfg.ollama.contextWindow * 0.65) return null;
		const withMessages = ctx.contextEntries.filter((e) => e.messages.length);
		// Keep the last ~6 message entries, starting at one that opens a turn (not a lone tool result).
		let keep = Math.max(0, withMessages.length - 6);
		while (keep < withMessages.length && withMessages[keep].messages[0]?.role === "toolResult") keep++;
		if (keep <= 0 || keep >= withMessages.length) return null;
		const t = this.tasks.current!;
		const summary = [
			`(Earlier conversation compacted during work mode.)`,
			`He approved a long task: ${t.goal}`,
			`Steps:\n${t.steps.map((s, i) => `${s.done ? "[x]" : "[ ]"} ${i + 1}. ${s.text}`).join("\n")}`,
			t.notes.length ? `Your notes so far:\n${t.notes.map((n) => `- ${n}`).join("\n")}` : "",
		]
			.filter(Boolean)
			.join("\n\n");
		this.emitEvent({ type: "repair", detail: `work mode: compacted context (${used} tokens used)` });
		return { type: "compaction" as const, summary, firstKeptEntryId: withMessages[keep].sourceEntry.id };
	}

	/** He pressed ⏹ (or quit): end work mode and interrupt whatever step is running. */
	async stopTask(): Promise<void> {
		if (!this.tasks?.running) return;
		this.tasks.stop("stopped");
		this.emitEvent({ type: "task", task: this.tasks.snapshot() });
		if (this.busy) await this.session.abort().catch(() => {});
		this.emitEvent({ type: "say", text: "Okay, dừng nhé. Chị đã lưu lại tiến độ rồi.", mood: "neutral", proactive: false });
	}

	/**
	 * A task is still running but nothing is happening (a step errored, the app restarted mid-task):
	 * pick it back up. Called from the heartbeat, so an approved job doesn't silently stall.
	 */
	async resumeTask(): Promise<boolean> {
		if (!this.tasks?.running || this.busy || this.loading) return false;
		const next = this.tasks.nextStep();
		this.grants.clear();
		this.run = { kind: "user", userText: this.tasks.current!.goal, toolsUsed: [], autoContinues: 0, lastText: "", finalText: "" };
		this.emitEvent({ type: "task", task: this.tasks.snapshot() });
		try {
			await this.session.sendCustomMessage(
				{ customType: "work_mode", content: `[work mode] Resume the approved task. Next: ${next ? `step ${next.index} — ${next.text}` : "check the goal is met and finish"}.`, display: false },
				{ triggerTurn: true },
			);
			await this.session.waitForIdle?.();
		} catch (e) {
			this.emitEvent({ type: "error", message: (e as Error).message });
		}
		return true;
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
		return this.session ? this.session.abort() : Promise.resolve();
	}

	saveConfig(next: Config): void {
		this.cfg = next;
		this.quests = new QuestBook(next.allowedRoots);
		saveConfig(next);
	}

	dispose(): void {
		this.screen?.stop();
		this.session?.dispose();
		this.sidecars?.dispose();
		winHelper.dispose();
	}
}
