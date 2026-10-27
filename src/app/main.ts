import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from "electron";
import { Brain, type BrainEvent } from "../core/brain.js";
import type { Config } from "../core/config.js";
import { Heartbeat } from "../core/heartbeat.js";
import { APP_ROOT, paths } from "../core/paths.js";
import { PERSONA_FILES, type PersonaFile } from "../core/persona.js";
import { vieneuVoices } from "../core/sidecars.js";
import { Speaker } from "../core/tts.js";
import { ROAM_SIZE, Roamer } from "./roam.js";

const RENDERER = join(APP_ROOT, "src", "app", "renderer");
const PRELOAD = join(APP_ROOT, "src", "app", "preload.cjs");
const CHAT_LOG = join(paths.state, "chat-log.jsonl");

interface ChatLine {
	role: "me" | "mai";
	text: string;
	mood?: string;
	proactive?: boolean;
	ts: number;
}

let pet: BrowserWindow | null = null;
let roamer: Roamer | null = null;
let settingsWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let muted = false;
const brain = new Brain();
const heartbeat = new Heartbeat(brain);
let speaker = makeSpeaker(brain.cfg);

function makeSpeaker(cfg: Config): Speaker {
	const s = new Speaker(cfg);
	s.onFallback = (reason) =>
		pet?.webContents.send("brain-event", { type: "error", message: `Local voice unavailable (${reason.slice(0, 120)}). Using the online voice for now.` });
	return s;
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => showPet());

function logChat(line: ChatLine): void {
	appendFileSync(CHAT_LOG, `${JSON.stringify(line)}\n`);
}

function recentChat(n = 60): ChatLine[] {
	if (!existsSync(CHAT_LOG)) return [];
	return readFileSync(CHAT_LOG, "utf8")
		.trim()
		.split("\n")
		.slice(-n)
		.flatMap((l) => {
			try {
				return [JSON.parse(l) as ChatLine];
			} catch {
				return [];
			}
		});
}

function spriteDir(set: string): string {
	for (const base of [paths.sprites, paths.bundledSprites]) {
		const dir = join(base, set);
		if (existsSync(join(dir, "sprite.json"))) return dir;
	}
	return join(paths.bundledSprites, "aza");
}

function spriteSets(): string[] {
	const sets = new Set<string>();
	for (const base of [paths.sprites, paths.bundledSprites]) {
		if (!existsSync(base)) continue;
		for (const d of readdirSync(base)) if (existsSync(join(base, d, "sprite.json"))) sets.add(d);
	}
	return [...sets];
}

/** Our windows only ever show our own pages; anything else is refused. */
function lockNavigation(win: BrowserWindow): void {
	win.webContents.on("will-navigate", (e) => e.preventDefault());
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function createPet(): void {
	const { workArea } = screen.getPrimaryDisplay();
	// She starts small, standing on the taskbar near the right edge; the Roamer resizes the window per mode.
	const { width: w, height: h } = ROAM_SIZE;
	pet = new BrowserWindow({
		width: w,
		height: h,
		x: workArea.x + workArea.width - w - 40,
		y: workArea.y + workArea.height - h,
		transparent: true,
		frame: false,
		resizable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		hasShadow: false,
		backgroundColor: "#00000000",
		webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
	});
	pet.setAlwaysOnTop(true, "floating");
	pet.loadFile(join(RENDERER, "pet.html"));
	lockNavigation(pet);
	roamer = new Roamer(pet, (channel, payload) => pet?.webContents.send(channel, payload));
	roamer.canWander = () => brain.cfg.pet.wander && !brain.busy && (brain.needs?.state.energy ?? 100) > 20;
	pet.webContents.once("did-finish-load", () => (brain.cfg.pet.startIn === "chat" ? roamer?.setMode("chat", true) : roamer?.start()));
	pet.on("closed", () => (pet = null));
}

function openSettings(): void {
	if (settingsWin) return settingsWin.focus();
	settingsWin = new BrowserWindow({
		width: 980,
		height: 720,
		title: "Mai — Settings",
		autoHideMenuBar: true,
		webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
	});
	settingsWin.loadFile(join(RENDERER, "settings.html"));
	lockNavigation(settingsWin);
	settingsWin.on("closed", () => (settingsWin = null));
}

function createTray(): void {
	const icon = nativeImage.createFromPath(join(spriteDir(brain.cfg.spriteSet), "idle", "idle.png")).resize({ width: 16, height: 16 });
	tray = new Tray(icon);
	tray.setToolTip("Mai");
	const rebuild = () =>
		tray!.setContextMenu(
			Menu.buildFromTemplate([
				{ label: "Show / hide Mai", click: () => (pet?.isVisible() ? pet.hide() : showPet()) },
				{ label: "Talk to me (Ctrl+Alt+M)", click: focusInput },
				{ label: "Settings, persona & history…", click: openSettings },
				{ type: "separator" },
				{ label: muted ? "Unmute voice" : "Mute voice", click: () => ((muted = !muted), rebuild()) },
				{ label: "Poke her", click: () => void brain.poke() },
				{ type: "separator" },
				{ label: "Quit", click: () => app.quit() },
			]),
		);
	rebuild();
	tray.on("click", () => showPet());
}

/** Bring her back from anywhere: hidden in the tray or shrunk to a floating head. */
function showPet(): void {
	if (!pet) return;
	roamer?.setMode("chat");
	pet.show();
	pet.focus();
}

function focusInput(): void {
	showPet();
	pet?.focus();
	pet?.webContents.send("focus-input");
}

/**
 * Voice pipeline: sentences arrive while she's still writing; each is synthesized in order and sent to the
 * pet as soon as it's ready (the pet queues playback), so sentence 2 renders while sentence 1 plays.
 * A new message from him bumps the generation and drops anything stale.
 */
let speechGen = 0;
let speechChain: Promise<void> = Promise.resolve();
function speak(text: string, mood: Parameters<Speaker["synthesize"]>[1]): void {
	if (muted) return;
	const gen = speechGen;
	speechChain = speechChain.then(async () => {
		if (gen !== speechGen || muted) return;
		try {
			const s = await speaker.synthesize(text, mood);
			if (s && gen === speechGen) pet?.webContents.send("speech", { audio: s.audio.toString("base64"), mime: s.mime, text, gen });
		} catch (e) {
			pet?.webContents.send("brain-event", { type: "error", message: `voice: ${(e as Error).message}` });
		}
	});
}
function stopSpeech(): void {
	speechGen++;
	pet?.webContents.send("speech-stop");
}

let hideHintShown = false;
function hidePet(): void {
	pet?.hide();
	if (!hideHintShown) {
		hideHintShown = true;
		new Notification({ title: "Mai is hiding in the tray", body: "Press Ctrl+Alt+M, or click her icon in the taskbar tray (^), to bring her back." }).show();
	}
}

function wireBrain(): void {
	brain.approver = async (req) => {
		pet?.show();
		const text = {
			powershell: { what: "PowerShell command", all: "commands", note: "Only allow this if you understand what it does." },
			move_file: { what: "file move", all: "moves", note: "Nothing moves unless you allow it." },
			read_file: { what: "reading a file", all: "reads", note: "She'll see this file's content." },
		}[req.kind];
		const r = await dialog.showMessageBox({
			type: req.kind === "powershell" ? "warning" : "question",
			title: `Mai is asking permission: ${text.what}`,
			message: `${req.summary}\n\n“${req.why}”`,
			detail: `${req.detail}\n\n${text.note}`,
			buttons: ["Allow once", `Allow all ${text.all} for this request`, "Deny"],
			defaultId: 2,
			cancelId: 2,
			noLink: true,
		});
		return r.response === 0 ? "once" : r.response === 1 ? "all" : "deny";
	};
	brain.on("event", (e: BrainEvent) => {
		pet?.webContents.send("brain-event", e);
		if (e.type === "utterance") speak(e.text, e.mood);
		if (e.type === "say" && roamer?.mode === "roam") roamer.setMode("chat");
		if (e.type === "say") {
			logChat({ role: "mai", text: e.text, mood: e.mood, proactive: e.proactive, ts: Date.now() });
			if (e.proactive && (!pet?.isVisible() || !pet.isFocused())) {
				pet?.showInactive();
				if (!pet?.isVisible()) new Notification({ title: "Mai", body: e.text.slice(0, 180) }).show();
			}
		}
		if (e.type === "persona_changed") settingsWin?.webContents.send("persona-changed");
	});
}

function registerIpc(): void {
	ipcMain.handle("chat", async (_e, text: string) => {
		logChat({ role: "me", text, ts: Date.now() });
		stopSpeech();
		await brain.chat(text);
	});
	ipcMain.handle("chat-history", () => recentChat());
	ipcMain.handle("sprite", () => {
		const dir = spriteDir(brain.cfg.spriteSet);
		return { base: `${pathToFileURL(dir).href}/`, manifest: JSON.parse(readFileSync(join(dir, "sprite.json"), "utf8")) };
	});
	ipcMain.handle("status", () => ({ mood: brain.mood.state, needs: brain.needs?.state, muted, busy: brain.busy, loading: brain.loading }));
	ipcMain.handle("open-settings", () => openSettings());
	ipcMain.handle("set-muted", (_e, m: boolean) => {
		muted = m;
		if (m) stopSpeech();
	});
	ipcMain.handle("wake", () => brain.poke());
	ipcMain.handle("feed", () => brain.feed());
	ipcMain.handle("planner", () => ({ events: brain.calendar.upcoming(24 * 7), todos: brain.todos.sorted() }));
	ipcMain.handle("todo-add", (_e, title: string) => {
		brain.todos.add({ title, createdBy: "user" });
		brain.emitEvent({ type: "planner_changed" });
	});
	ipcMain.handle("todo-toggle", (_e, id: string, done: boolean) => brain.toggleTodo(id, done));
	ipcMain.handle("todo-remove", (_e, id: string) => {
		brain.todos.remove(id);
		brain.emitEvent({ type: "planner_changed" });
	});
	ipcMain.handle("event-remove", (_e, id: string) => {
		brain.calendar.remove(id);
		brain.emitEvent({ type: "planner_changed" });
	});

	ipcMain.handle("hide", () => hidePet());
	ipcMain.on("click-through", (_e, on: boolean) => pet?.setIgnoreMouseEvents(on, { forward: true }));
	ipcMain.on("pet-move", (_e, dx: number, dy: number) => roamer?.moveBy(dx, dy));
	ipcMain.on("pet-grab", () => roamer?.grab());
	ipcMain.on("pet-release", () => roamer?.release());
	ipcMain.on("pet-mode", (_e, mode: "chat" | "roam") => roamer?.setMode(mode));
	ipcMain.handle("open-link", (_e, url: string) => {
		if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
	});

	ipcMain.handle("get-config", () => brain.cfg);
	ipcMain.handle("save-config", (_e, cfg: Config) => {
		brain.saveConfig(cfg);
		speaker = makeSpeaker(cfg);
		pet?.reload();
		return { ok: true, note: "Saved. Model, heartbeat-interval and voice-server (backend/threads) changes apply after restarting Mai." };
	});
	ipcMain.handle("persona-files", () => Object.fromEntries(PERSONA_FILES.map((f) => [f, brain.persona.read(f)])));
	ipcMain.handle("save-persona", (_e, file: PersonaFile, content: string) => brain.persona.write(file, content, `edited ${file} in settings`, "user"));
	ipcMain.handle("persona-history", () => brain.persona.history(100));
	ipcMain.handle("persona-diff", (_e, rev: string) => brain.persona.diff(rev));
	ipcMain.handle("persona-rollback", (_e, rev: string) => brain.persona.rollback(rev));
	ipcMain.handle("sprite-sets", () => spriteSets());
	ipcMain.handle("tts-voices", () => vieneuVoices());
	ipcMain.handle("open-path", (_e, which: "sprites" | "data" | "persona") =>
		shell.openPath(which === "sprites" ? paths.sprites : which === "persona" ? paths.persona : paths.data),
	);
}

app.whenReady().then(async () => {
	registerIpc();
	createPet();
	createTray();
	wireBrain();
	// Another app may already own the hotkey; fall back so there's always a way to call her back.
	if (!globalShortcut.register("Control+Alt+M", focusInput) && globalShortcut.register("Control+Alt+Shift+M", focusInput))
		pet?.webContents.once("did-finish-load", () =>
			pet?.webContents.send("brain-event", { type: "error", message: "Ctrl+Alt+M is taken by another app, so use Ctrl+Alt+Shift+M to call me." }),
		);
	if (process.argv.includes("--settings")) openSettings();
	try {
		await brain.start();
		heartbeat.start();
		pet?.webContents.send("brain-event", { type: "state", state: "idle" });
	} catch (e) {
		pet?.webContents.send("brain-event", { type: "error", message: (e as Error).message });
	}
});

app.on("window-all-closed", () => {
	/* live in the tray */
});
app.on("will-quit", () => {
	roamer?.stop();
	globalShortcut.unregisterAll();
	heartbeat.stop();
	brain.dispose();
});
