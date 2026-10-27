import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { unzipSync } from "fflate";
import { OfficeGenerator, OfficeParser } from "officeparser";

/**
 * "Read this file" for Mai: turns many formats into text she can reason about, paged so a big document
 * never floods her context window. What it can't interpret yet is listed in docs/ROADMAP.md.
 */

const TEXT_EXT = new Set(
	".txt .md .markdown .log .json .jsonl .yaml .yml .toml .ini .cfg .conf .env.example .xml .svg .srt .vtt .sql .csv .tsv .bat .cmd .ps1 .psm1 .sh .py .js .mjs .cjs .ts .tsx .jsx .java .kt .c .h .cpp .hpp .cs .go .rs .rb .php .lua .swift .dart .r .m .vue .svelte .css .scss .less .gitignore .dockerfile .gradle .properties".split(" "),
);
const DOC_EXT = new Set(".pdf .docx .pptx .xlsx .odt .odp .ods .odg .rtf .epub .html .htm .tex".split(" "));
const IMAGE_EXT = new Set(".png .jpg .jpeg .webp .bmp .gif".split(" "));
const ZIP_EXT = new Set(".zip .jar .apk .nupkg .vsix".split(" "));
const AUDIO_VIDEO_EXT = new Set(".mp3 .wav .m4a .flac .ogg .opus .mp4 .mkv .mov .avi .webm".split(" "));

/** Files she should never open, even if he asks: secrets and credential stores. */
const SECRET = /[\\/]\.ssh[\\/]|\.kdbx?$|\.pem$|\.pfx$|\.p12$|(^|[\\/])id_(rsa|ed25519|ecdsa)$|wallet\.dat$|[\\/]Login Data$|[\\/]Cookies$|(^|[\\/])\.env$|\.(key)$/i;

export type FileKind = "text" | "document" | "image" | "archive" | "media" | "binary";

export function fileKind(path: string): FileKind {
	const ext = extname(path).toLowerCase();
	const name = basename(path).toLowerCase();
	if (TEXT_EXT.has(ext) || name === "dockerfile" || name === "makefile" || name === "readme") return "text";
	if (DOC_EXT.has(ext)) return "document";
	if (IMAGE_EXT.has(ext)) return "image";
	if (ZIP_EXT.has(ext)) return "archive";
	if (AUDIO_VIDEO_EXT.has(ext)) return "media";
	return "binary";
}

export function isSecretPath(path: string): boolean {
	return SECRET.test(path);
}

function looksBinary(buf: Buffer): boolean {
	const n = Math.min(buf.length, 8192);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
	return false;
}

// Parsed text is cached per file version so paging through a long PDF doesn't re-parse it each time.
const cache = new Map<string, string>();
function remember(key: string, text: string): string {
	cache.set(key, text);
	if (cache.size > 6) cache.delete(cache.keys().next().value as string);
	return text;
}

async function extract(path: string, kind: FileKind, size: number): Promise<string> {
	const key = `${path}|${statSync(path).mtimeMs}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	if (kind === "document") {
		const ast: any = await OfficeParser.parseOffice(path, { ignoreNotes: false } as any);
		const toMd = async (a: any) =>
			((await OfficeGenerator.generate(a, "md" as any)) as any).value
				// Metadata front-matter ("---" / "created: …" / "---") and heading anchors are noise for her.
				// Only key: value blocks count: a bare "---" also separates sheets and slides.
				.replace(/^(\s*---\r?\n(?:[A-Za-z][\w ]*:.*\r?\n)+---\r?\n)+/, "")
				.replace(/[ \t]*\{#[^}\n]*\}/g, "")
				.trim() as string;
		const parts = ast.content ?? [];
		// Spreadsheets and decks: label each sheet / slide so she knows where she is.
		if (parts.length > 1 && parts.every((n: any) => n.type === "sheet" || n.type === "slide")) {
			const out: string[] = [];
			for (const [i, node] of parts.entries()) {
				const label = node.type === "sheet" ? `Sheet: ${node.metadata?.sheetName ?? i + 1}` : `Slide ${i + 1}`;
				out.push(`## ${label}\n\n${(await toMd({ ...ast, metadata: {}, content: [node] })).replace(/^---\s*/, "")}`);
			}
			return remember(key, out.join("\n\n"));
		}
		return remember(key, await toMd(ast));
	}
	if (kind === "archive") {
		const entries: string[] = [];
		unzipSync(readFileSync(path), {
			filter: (f) => {
				entries.push(`${f.name}  (${f.originalSize.toLocaleString()} bytes)`);
				return false; // list only, don't decompress
			},
		});
		return remember(key, `${entries.length} entries:\n${entries.join("\n")}`);
	}
	const buf = readFileSync(path);
	if (kind === "binary" && looksBinary(buf)) {
		return remember(key, `(binary file, ${size.toLocaleString()} bytes; not a format I can interpret)`);
	}
	return remember(key, buf.toString("utf8").replace(/^﻿/, ""));
}

export interface ReadResult {
	kind: FileKind;
	text: string;
}

/**
 * @param describeImage asks the local vision model about an image (base64), used for image files.
 */
export async function readAnyFile(
	path: string,
	opts: { offset?: number; maxChars?: number; question?: string },
	describeImage: (b64: string, question: string) => Promise<string>,
): Promise<ReadResult> {
	const st = statSync(path);
	if (st.isDirectory()) throw new Error(`${path} is a folder; use list_folder.`);
	const kind = fileKind(path);
	const info = `${basename(path)} · ${(st.size / 1024).toFixed(0)} KB · modified ${st.mtime.toISOString().slice(0, 16).replace("T", " ")}`;

	if (kind === "image") {
		if (st.size > 15 * 1024 * 1024) return { kind, text: `[${info}] Image too large to look at (>15 MB).` };
		const answer = await describeImage(readFileSync(path).toString("base64"), opts.question ?? "Describe this image in detail, including any text in it.");
		return { kind, text: `[${info}, image]\n${answer}` };
	}
	if (kind === "media") {
		return { kind, text: `[${info}] Audio/video: I can't listen to or watch files yet (planned: transcription). I only know its name and size.` };
	}
	if (st.size > 200 * 1024 * 1024) return { kind, text: `[${info}] Too large to read (>200 MB).` };

	const full = await extract(path, kind, st.size);
	const offset = Math.max(0, opts.offset ?? 0);
	const max = Math.min(Math.max(opts.maxChars ?? 6000, 500), 12000);
	const slice = full.slice(offset, offset + max);
	const end = offset + slice.length;
	const more = end < full.length ? `\n…[more: call read_file again with offset ${end}]` : "";
	const range = full.length > max ? ` · chars ${offset}–${end} of ${full.length}` : "";
	return { kind, text: `[${info}, ${kind}${range}]\n${slice || "(empty)"}${more}` };
}
