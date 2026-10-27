import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (works from both src/ via tsx and dist/ via tsc). */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** All mutable user data lives here. Override with MAI_HOME. */
export const DATA_DIR = resolve(process.env.MAI_HOME ?? join(homedir(), ".mai-companion"));

export const paths = {
	data: DATA_DIR,
	config: join(DATA_DIR, "config.json"),
	persona: join(DATA_DIR, "persona"),
	state: join(DATA_DIR, "state"),
	sessions: join(DATA_DIR, "sessions"),
	sprites: join(DATA_DIR, "sprites"),
	screenshots: join(DATA_DIR, "state", "screens"),
	pi: join(DATA_DIR, "pi"),
	personaTemplate: join(APP_ROOT, "persona-template"),
	bundledSprites: join(APP_ROOT, "sprites"),
	needleSidecar: join(APP_ROOT, "sidecars", "needle"),
};

export function ensureDirs(): void {
	for (const p of [paths.data, paths.persona, paths.state, paths.sessions, paths.sprites, paths.screenshots, paths.pi]) {
		mkdirSync(p, { recursive: true });
	}
}
