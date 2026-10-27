import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { APP_ROOT } from "./paths.js";

/** One persistent PowerShell process, so Win32 calls cost milliseconds instead of a cold start each time. */
export class WinHelper {
	private proc?: ChildProcessWithoutNullStreams;
	private queue: Array<(v: any) => void> = [];
	private chain: Promise<unknown> = Promise.resolve();

	private start(): void {
		const script = join(APP_ROOT, "native", "winhelper.ps1");
		this.proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
			windowsHide: true,
		});
		const rl = createInterface({ input: this.proc.stdout });
		rl.on("line", (line) => {
			const resolve = this.queue.shift();
			if (!resolve) return;
			try {
				resolve(JSON.parse(line));
			} catch {
				resolve({ ok: false, error: `bad helper output: ${line.slice(0, 200)}` });
			}
		});
		this.proc.on("exit", () => {
			for (const r of this.queue.splice(0)) r({ ok: false, error: "helper exited" });
			this.proc = undefined;
		});
	}

	/** Commands are serialized; the helper answers strictly in order. */
	send<T = any>(cmd: string, timeoutMs = 15_000): Promise<T> {
		const run = () =>
			new Promise<T>((resolve) => {
				if (process.platform !== "win32") return resolve({ ok: false, error: "Windows only" } as T);
				if (!this.proc) this.start();
				const timer = setTimeout(() => {
					const i = this.queue.indexOf(done);
					if (i >= 0) this.queue.splice(i, 1);
					// A late reply would be matched to the wrong caller, so start over with a fresh helper.
					this.proc?.kill();
					resolve({ ok: false, error: "helper timeout" } as T);
				}, timeoutMs);
				const done = (v: T) => {
					clearTimeout(timer);
					resolve(v);
				};
				this.queue.push(done);
				this.proc!.stdin.write(`${cmd}\n`);
			});
		const p = this.chain.then(run, run);
		this.chain = p;
		return p;
	}

	dispose(): void {
		this.proc?.kill();
	}
}

export const winHelper = new WinHelper();
