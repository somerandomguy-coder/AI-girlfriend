import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { paths } from "./paths.js";
import { winHelper } from "./winhelper.js";

export interface ActivitySpan {
	process: string;
	title: string;
	since: number;
}

/**
 * Cheap, always-on awareness: which window is in front, for how long, and how long he's been idle.
 * Screenshots are a separate, opt-in step (see `screenshot`).
 */
export class ScreenWatcher {
	current?: ActivitySpan;
	idleMs = 0;
	recent: Array<ActivitySpan & { until: number }> = [];
	private timer?: NodeJS.Timeout;

	constructor(private readonly cfg: Config) {}

	isBlocked(text: string): boolean {
		const t = text.toLowerCase();
		return this.cfg.screen.blocklist.some((b) => t.includes(b.toLowerCase()));
	}

	start(intervalMs = 15_000): void {
		if (!this.cfg.screen.watchWindows || this.timer) return;
		const tick = async () => {
			const r = await winHelper.send<{ ok: boolean; title: string; process: string; idleMs: number }>("poll");
			if (!r.ok) return;
			this.idleMs = r.idleMs;
			const blocked = this.isBlocked(`${r.process} ${r.title}`);
			const title = blocked ? "(private window)" : r.title;
			if (!this.current || this.current.process !== r.process || this.current.title !== title) {
				if (this.current) this.recent.push({ ...this.current, until: Date.now() });
				this.recent = this.recent.slice(-15);
				this.current = { process: r.process, title, since: Date.now() };
			}
		};
		void tick();
		this.timer = setInterval(() => void tick(), intervalMs);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Same app (by process) continuously, in minutes. */
	minutesOnCurrentApp(): number {
		if (!this.current) return 0;
		let since = this.current.since;
		for (let i = this.recent.length - 1; i >= 0 && this.recent[i].process === this.current.process; i--) since = this.recent[i].since;
		return Math.round((Date.now() - since) / 60_000);
	}

	describe(): string {
		if (!this.current) return "Screen: unknown (watching disabled or not Windows).";
		const idleMin = Math.round(this.idleMs / 60_000);
		const away = idleMin >= 5 ? ` He has been idle/away for ${idleMin} min.` : "";
		const recent = this.recent
			.slice(-4)
			.map((s) => s.process)
			.join(" → ");
		return `Screen: he's in ${this.current.process} ("${this.current.title.slice(0, 80)}") for ${this.minutesOnCurrentApp()} min.${away} Recent apps: ${recent || "n/a"}.`;
	}

	/** Grab a downscaled screenshot as base64 JPEG and delete the file immediately. */
	async screenshot(): Promise<{ ok: true; base64: string } | { ok: false; error: string }> {
		if (!this.cfg.screen.allowScreenshots) return { ok: false, error: "Screenshots are turned off in settings." };
		if (this.current && this.isBlocked(`${this.current.process} ${this.current.title}`))
			return { ok: false, error: "A private window is in front; not looking." };
		const file = join(paths.screenshots, `peek-${Date.now()}.jpg`);
		const r = await winHelper.send<{ ok: boolean; error?: string }>(`screenshot ${file} 1280`, 20_000);
		if (!r.ok) return { ok: false, error: r.error ?? "screenshot failed" };
		const base64 = readFileSync(file).toString("base64");
		rmSync(file, { force: true });
		return { ok: true, base64 };
	}
}
