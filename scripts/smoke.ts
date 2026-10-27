// Smoke test: does pi SDK + Ollama + a custom tool work end-to-end?
// Usage: npx tsx scripts/smoke.ts [model-id]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const modelId = process.argv[2] ?? "mai-gemma";
const dir = join(process.cwd(), ".smoke");
mkdirSync(dir, { recursive: true });
writeFileSync(
	join(dir, "models.json"),
	JSON.stringify({
		providers: {
			ollama: {
				baseUrl: "http://127.0.0.1:11434/v1",
				api: "openai-completions",
				apiKey: "ollama",
				models: [{ id: modelId, contextWindow: 16384, maxTokens: 2048, input: ["text", "image"] }],
			},
		},
	}),
);

const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
const model = modelRuntime.getModel("ollama", modelId);
if (!model) throw new Error("model not found");

const weather = defineTool({
	name: "get_weather",
	label: "Weather",
	description: "Get current weather for a city.",
	parameters: Type.Object({ city: Type.String() }),
	async execute(_id, params) {
		return { content: [{ type: "text", text: JSON.stringify({ city: params.city, temp_c: 31, sky: "humid, thunderstorms later" }) }], details: undefined };
	},
});

const resourceLoader: ResourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => "You are Mai, a bossy but caring companion. Use tools when needed. Reply briefly.",
	getSystemPromptSource: () => undefined,
	getAppendSystemPrompt: () => [],
	getAppendSystemPromptSources: () => [],
	extendResources: () => {},
	reload: async () => {},
};

const { session } = await createAgentSession({
	cwd: process.cwd(),
	agentDir: dir,
	model,
	thinkingLevel: "off",
	modelRuntime,
	resourceLoader,
	noTools: true,
	customTools: [weather],
	sessionManager: SessionManager.inMemory(process.cwd()),
	settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } }),
});

session.subscribe((e) => {
	if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") process.stdout.write(e.assistantMessageEvent.delta);
	if (e.type === "tool_execution_start") console.log(`\n[tool] ${e.toolName} ${JSON.stringify(e.args)}`);
});
const t0 = Date.now();
await session.prompt("Thời tiết ở Sài Gòn hôm nay thế nào? Should I bring an umbrella?");
console.log(`\n--- ${((Date.now() - t0) / 1000).toFixed(1)}s, active tools: ${session.getActiveToolNames().join(",")}`);
session.dispose();
