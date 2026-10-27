import { type BrowserWindow, screen } from "electron";

/**
 * Where the pet window lives on the desktop.
 *  - chat: the full window (bubble, planner, input) anchored above where she stands.
 *  - roam: a small window with just her, standing on the taskbar and wandering left and right.
 * Dragging works in both; in roam mode a drop makes her fall back down to the taskbar.
 */
export type PetMode = "chat" | "roam";

export const CHAT_SIZE = { width: 400, height: 760 };
export const ROAM_SIZE = { width: 170, height: 200 };

type Behaviour = "idle" | "walk" | "fall" | "held";

export class Roamer {
	mode: PetMode = "roam";
	private behaviour: Behaviour = "idle";
	private timer?: NodeJS.Timeout;
	private targetX = 0;
	private vy = 0;
	private facing: "left" | "right" = "left";
	/** Set by the app: she stays put while sleepy, busy talking, or when wandering is turned off. */
	canWander: () => boolean = () => true;

	constructor(
		private readonly win: BrowserWindow,
		private readonly send: (channel: string, payload: unknown) => void,
	) {}

	private area() {
		return screen.getDisplayMatching(this.win.getBounds()).workArea;
	}

	private floorY(height = ROAM_SIZE.height): number {
		const a = this.area();
		return a.y + a.height - height;
	}

	private emit(): void {
		this.send("pet-pose", { mode: this.mode, behaviour: this.behaviour, facing: this.facing });
	}

	start(): void {
		this.setMode("roam", true);
	}

	stop(): void {
		clearTimeout(this.timer);
	}

	setMode(mode: PetMode, force = false): void {
		if (mode === this.mode && !force) return;
		clearTimeout(this.timer);
		const b = this.win.getBounds();
		const a = this.area();
		const centerX = b.x + b.width / 2;
		if (mode === "roam") {
			const x = Math.round(Math.max(a.x, Math.min(centerX - ROAM_SIZE.width / 2, a.x + a.width - ROAM_SIZE.width)));
			this.win.setBounds({ x, y: this.floorY(), ...ROAM_SIZE });
			this.mode = "roam";
			this.behaviour = "idle";
			this.scheduleNext(1500);
		} else {
			const h = Math.min(CHAT_SIZE.height, a.height - 10);
			const x = Math.round(Math.max(a.x, Math.min(centerX - CHAT_SIZE.width / 2, a.x + a.width - CHAT_SIZE.width)));
			// Bottom-anchored, so her feet stay where they were.
			const y = Math.max(a.y, Math.min(b.y + b.height - h, a.y + a.height - h));
			this.win.setBounds({ x, y, width: CHAT_SIZE.width, height: h });
			this.mode = "chat";
			this.behaviour = "idle";
		}
		this.emit();
	}

	/** Pick the next thing to do: mostly stand around, sometimes stroll somewhere. */
	private scheduleNext(delay = 3000 + Math.random() * 9000): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			if (this.mode !== "roam" || this.behaviour === "held") return;
			if (!this.canWander() || Math.random() < 0.35) {
				this.behaviour = "idle";
				this.emit();
				return this.scheduleNext();
			}
			const a = this.area();
			const b = this.win.getBounds();
			const span = 120 + Math.random() * 420;
			let dir = Math.random() < 0.5 ? -1 : 1;
			if (b.x + dir * span < a.x || b.x + b.width + dir * span > a.x + a.width) dir = -dir;
			this.targetX = Math.round(Math.max(a.x, Math.min(b.x + dir * span, a.x + a.width - b.width)));
			this.facing = dir < 0 ? "left" : "right";
			this.behaviour = "walk";
			this.emit();
			this.step();
		}, delay);
	}

	/** ~60 px/s stroll, 25 fps. */
	private step(): void {
		this.timer = setTimeout(() => {
			if (this.mode !== "roam" || this.behaviour !== "walk") return;
			const b = this.win.getBounds();
			const dx = this.targetX - b.x;
			if (Math.abs(dx) <= 3) {
				this.behaviour = "idle";
				this.emit();
				return this.scheduleNext();
			}
			this.win.setPosition(b.x + Math.sign(dx) * Math.min(3, Math.abs(dx)), this.floorY());
			this.step();
		}, 40);
	}

	/** He grabbed her: stop whatever she was doing. */
	grab(): void {
		clearTimeout(this.timer);
		this.behaviour = "held";
		this.emit();
	}

	moveBy(dx: number, dy: number): void {
		const [x, y] = this.win.getPosition();
		this.win.setPosition(Math.round(x + dx), Math.round(y + dy));
		if (dx) this.facing = dx < 0 ? "left" : "right";
	}

	/** He let go. In roam mode she falls back to the taskbar with a little gravity. */
	release(): void {
		if (this.mode !== "roam") {
			this.behaviour = "idle";
			this.emit();
			return;
		}
		this.behaviour = "fall";
		this.vy = 0;
		this.emit();
		const fall = () => {
			const [x, y] = this.win.getPosition();
			const floor = this.floorY();
			const a = this.area();
			const cx = Math.max(a.x, Math.min(x, a.x + a.width - ROAM_SIZE.width));
			if (y >= floor) {
				this.win.setPosition(cx, floor);
				this.behaviour = "idle";
				this.emit();
				return this.scheduleNext(2000);
			}
			this.vy = Math.min(this.vy + 2.2, 40);
			this.win.setPosition(cx, Math.min(floor, Math.round(y + this.vy)));
			this.timer = setTimeout(fall, 16);
		};
		fall();
	}
}
