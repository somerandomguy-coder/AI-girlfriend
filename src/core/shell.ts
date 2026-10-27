import { spawn } from "node:child_process";
import { homedir } from "node:os";

/**
 * PowerShell for Mai, in three tiers:
 *  - blocked: never runs (wiping disks, system folders, registry deletes, download-and-execute, disabling security).
 *  - read-only: only Get-/Test-/Measure-… style cmdlets and plain formatting; runs without asking.
 *  - everything else: needs his approval (dialog in the app; denied in the terminal client).
 */

const BLOCKED: Array<[RegExp, string]> = [
	[/\bformat-volume\b|\bclear-disk\b|\binitialize-disk\b|\bremove-partition\b|\bdiskpart\b|\bformat\s+[a-z]:/i, "disk formatting/partitioning"],
	[
		/(remove-item|\brm\b|\bdel\b|\brmdir\b|\brd\b|\bri\b)[^|;]*(\b[a-z]:\\?(?=[\s"';|]|$)|c:\\(windows|program files( \(x86\))?|programdata|users)\\?(?=[\s"';|]|$)|\$env:(windir|systemroot|programfiles|userprofile)\\?(?=[\s"';|]|$))/i,
		"deleting a drive root or system folder",
	],
	[/\b(reg\s+delete|remove-itemproperty\s+[^|;]*hklm:)/i, "registry deletion"],
	[/\b(iex|invoke-expression)\b|\|\s*(iex|invoke-expression)\b|downloadstring|frombase64string.*invoke/i, "download-and-execute / dynamic code"],
	[/set-mppreference|disable(-|\s)?(windows)?defender|set-executionpolicy\s+(unrestricted|bypass)|netsh\s+advfirewall\s+set\s+\w+\s+state\s+off/i, "disabling security"],
	[/\b(stop-computer|restart-computer|shutdown(\.exe)?\s+\/[srp])\b/i, "shutting down/restarting the PC"],
	[/\bvssadmin\b.*delete|\bbcdedit\b|\bcipher\s+\/w/i, "destroying backups/boot config"],
	[/\b(new-localuser|add-localgroupmember|net\s+user\s+\S+\s+\S+\s+\/add)\b/i, "creating accounts"],
];

/** Cmdlet verbs/names that only look at things. Every Verb-Noun anywhere in the command must be one of these. */
const READ_VERBS = new Set(["get", "test", "measure", "select", "where", "sort", "group", "format", "resolve", "compare", "convertto", "convertfrom", "find", "search", "split", "join", "foreach", "tee"]);
const READ_CMDLETS = new Set(["out-string", "out-null", "write-output", "write-host"]);
/** Bare (dash-less) commands allowed at the start of a statement. */
const READ_WORDS = new Set([
	"whoami", "hostname", "ipconfig", "systeminfo", "tasklist", "nvidia-smi", "ver", "where", "where.exe", "echo", "dir", "ls", "cat", "type", "gc", "gci", "gps", "gsv",
	"gcim", "gwmi", "date", "select", "sort", "measure", "ft", "fl", "%", "?", "if", "else", "elseif", "foreach", "for", "while", "return", "true", "false", "null",
]);

export type ShellTier = "blocked" | "read" | "write";

export function classify(command: string): { tier: ShellTier; reason?: string } {
	for (const [re, why] of BLOCKED) if (re.test(command)) return { tier: "blocked", reason: why };
	// Quoted text can't run anything; drop it so names like 'Mai-Test' aren't mistaken for cmdlets.
	const code = command.replace(/'[^']*'|"[^"]*"/g, "''");
	// Redirection to files, launching processes, invoking things, call operator, cmd → write.
	if (/(^|[^2])>{1,2}\s*[^&\s]|\bstart-process\b|\binvoke-|&\s*['$({]|\bcmd(\.exe)?\s+\/c/i.test(code)) return { tier: "write" };
	// .NET calls that mutate ([IO.File]::Delete(...), $p.Kill()).
	if (/(::|\.)(delete|kill|remove|move|copy|write\w*|create\w*|set\w*|start|stop|append\w*|replace|exit)\s*\(/i.test(code)) return { tier: "write" };
	// Every Verb-Noun cmdlet anywhere, including inside { } blocks.
	for (const m of code.matchAll(/(?<![\w$-])([a-z]+)-([a-z][a-z0-9]*)\b/gi)) {
		const name = `${m[1]}-${m[2]}`.toLowerCase();
		if (!READ_VERBS.has(m[1].toLowerCase()) && !READ_CMDLETS.has(name)) return { tier: "write" };
		if (name === "ollama-run") return { tier: "write" };
	}
	// Bare words at the start of each statement (after start, | ; { ( or newline); `word =` is a hashtable key or assignment.
	for (const m of code.matchAll(/(?:^|[|;{(\n])\s*([a-z%?][\w.%?-]*)\b(?!\s*=)/gi)) {
		const word = m[1].toLowerCase();
		if (word.includes("-") && !READ_WORDS.has(word)) continue; // cmdlets were checked above
		if (!READ_WORDS.has(word) && !(word === "ollama" && /\bollama\s+(list|ps)\b/i.test(code))) return { tier: "write" };
	}
	return { tier: "read" };
}

export interface ShellResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
}

export function runPowerShell(command: string, timeoutMs = 60_000, maxChars = 6000): Promise<ShellResult> {
	return new Promise((resolve) => {
		// UTF-8 in and out, so Vietnamese file names survive.
		const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${command}`;
		const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			cwd: homedir(),
			windowsHide: true,
		});
		let out = "";
		const add = (b: Buffer) => {
			if (out.length < maxChars * 2) out += b.toString("utf8");
		};
		p.stdout.on("data", add);
		p.stderr.on("data", add);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			p.kill();
		}, timeoutMs);
		p.on("close", (code) => {
			clearTimeout(timer);
			const trimmed = out.length > maxChars ? `${out.slice(0, maxChars)}\n… (${out.length - maxChars} more characters cut)` : out;
			resolve({ exitCode: code, output: trimmed.trim() || "(no output)", timedOut });
		});
	});
}
