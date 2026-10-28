// Fake `window.mai` bridge with sample data, so the real pet/settings pages can be rendered for docs.
const { pathToFileURL } = require("url");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const spriteDir = path.join(root, "sprites", process.env.MAI_SPRITE || "aza");
const handlers = {};
const at = (days, h, m = 0) => {
	const d = new Date();
	d.setDate(d.getDate() + days);
	d.setHours(h, m, 0, 0);
	return d.toISOString();
};
const persona = Object.fromEntries(
	["SOUL.md", "USER.md", "MEMORY.md", "HEARTBEAT.md"].map((f) => [f, fs.readFileSync(path.join(root, "persona-template", f), "utf8")]),
);
persona["USER.md"] += "- Name: Nam. Likes trà sữa, hates mornings.\n- Has a job interview Friday 10:00.\n";

window.mai = {
	send: async () => {},
	onEvent: (cb) => (handlers.event = cb),
	onSpeech: () => {},
	onSpeechStop: () => {},
	onFocusInput: () => {},
	onPose: (cb) => (handlers.pose = cb),
	sprite: async () => ({ base: `${pathToFileURL(spriteDir).href}/`, manifest: JSON.parse(fs.readFileSync(path.join(spriteDir, "sprite.json"), "utf8")) }),
	status: async () => ({ mood: { affection: 46 }, needs: { hunger: 78, energy: 72, social: 35, fun: 60, worry: 20 }, muted: false }),
	history: async () => [
		{ role: "me", text: "chị ơi em đói", ts: Date.now() - 600000 },
		{ role: "mai", text: "Đói thì đi ăn đi, nhóc. **Ngay.**", ts: Date.now() - 590000 },
	],
	clearChat: async () => ({ ok: true }),
	onChatCleared: () => {},
	openSettings() {}, setMuted() {}, wake() {}, hide() {}, openLink() {}, setClickThrough() {}, moveBy() {}, setMode() {}, grab() {}, release() {},
	feed() {}, todoAdd() {}, todoToggle() {}, todoRemove() {}, eventRemove() {},
	planner: async () => ({
		todos: [
			{ id: "a1", title: "Nộp báo cáo", due: at(-1, 17), priority: "high", done: false, createdBy: "user" },
			{ id: "b2", title: "Gọi điện cho mẹ", due: at(0, 20), priority: "normal", done: false, createdBy: "mai" },
			{ id: "c3", title: "Drink 2L of water", priority: "normal", done: false, createdBy: "mai" },
			{ id: "d4", title: "Dọn thư mục Downloads", priority: "low", done: true, createdBy: "user" },
		],
		events: [
			{ id: "e1", title: "Call mom", start: at(0, 20) },
			{ id: "e2", title: "Job interview", start: at(3, 10) },
			{ id: "e3", title: "Gym", start: at(4, 18), repeat: "weekly" },
		],
	}),
	// settings window
	getConfig: async () => ({
		ollama: { model: "mai-brain", smallModel: "mai-helper", contextWindow: 16384, think: false, baseUrl: "http://127.0.0.1:11434" },
		heartbeat: { enabled: true, intervalMinutes: 20, maxProactivePerDay: 12, quietHours: { start: 1, end: 8 }, spontaneity: 0.35 },
		screen: { watchWindows: true, allowScreenshots: false, blocklist: ["1password", "bank"] },
		tts: { engine: "vieneu", voiceEn: "en-US-AvaMultilingualNeural", voiceVi: "vi-VN-HoaiMyNeural", vieneu: { voice: "truc_ly", backend: "cpu", threads: 6, autostart: true }, voxcpm2: { voiceRef: "" }, openai: { baseUrl: "", model: "", voice: "" } },
		quests: { enabled: true, maxActive: 2 },
		allowedRoots: ["C:\\Users\\you\\Desktop", "C:\\Users\\you\\Downloads"],
		repair: { useNeedle: true },
		agent: { maxAutoContinues: 3 },
		shell: { enabled: true, approval: "writes", timeoutSeconds: 60 },
		spriteSet: "aza",
	}),
	saveConfig: async () => ({ ok: true, note: "" }),
	personaFiles: async () => persona,
	savePersona: async () => null,
	personaHistory: async () => [
		{ rev: "9040fd9", date: at(0, 21, 14), author: "mai", message: "He asked me to call him 'nhóc' more often" },
		{ rev: "8779b18", date: at(0, 21, 2), author: "mai", message: "remember: Job interview Friday 10:00 — ask how it went" },
		{ rev: "200eea5", date: at(0, 20, 55), author: "mai", message: "remember: Name: Nam. Likes trà sữa" },
		{ rev: "13c9fbc", date: at(-1, 18), author: "system", message: "Initial persona" },
	],
	personaDiff: async () =>
		"commit 9040fd9\n[mai] He asked me to call him 'nhóc' more often\n\n SOUL.md | 2 +-\n\n--- a/SOUL.md\n+++ b/SOUL.md\n@@ -11,3 +11,3 @@\n-- Pet names I like: \"kid\", \"good boy\" (only when he earned it), \"em\", \"nhóc\".\n+- Pet names I like: \"nhóc\", \"kid\", \"good boy\" (only when he earned it), \"em\".\n",
	personaRollback: async () => null,
	spriteSets: async () => ["aza"],
	ttsVoices: async () => [{ id: "truc_ly", label: "⭐ Trúc Ly — Nữ · Bắc · Phong cách tự nhiên" }],
	openPath() {},
	onPersonaChanged() {},
};

window.__demo = {
	say(text, mood = "stern") {
		handlers.event?.({ type: "mood", mood, affection: 46 });
		handlers.event?.({ type: "say", text, mood, proactive: false });
	},
	pose(p) {
		handlers.pose?.(p);
	},
	click(id) {
		document.getElementById(id).click();
	},
};
