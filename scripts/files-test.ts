// Tests read_file's format support on generated fixtures. Usage: npx tsx scripts/files-test.ts [--vision]
// --vision also asks the real local vision model (Ollama) about an image.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { OfficeGenerator, OfficeParser } from "officeparser";
import { fileKind, isSecretPath, readAnyFile } from "../src/core/files.js";
import { ollamaChat } from "../src/core/ollama.js";

const dir = mkdtempSync(join(tmpdir(), "mai-files-"));
const md = [
	"# Báo cáo tuần",
	"",
	"Doanh thu tăng **12%** so với tuần trước.",
	"",
	"| Sản phẩm | Số lượng |",
	"|---|---|",
	"| Trà sữa | 120 |",
	"| Bánh mì | 85 |",
	"",
	"- Việc cần làm: gọi cho chị Lan",
	"- Hạn chót: thứ Sáu",
].join("\n");

// The fixture PDF writer's built-in fonts can't encode Vietnamese, so the PDF fixture is the English version.
const mdEn = md.replace("Báo cáo tuần", "Weekly report").replace("Trà sữa", "Milk tea").replace("Bánh mì", "Banh mi");
const ast = await OfficeParser.parseOffice(Buffer.from(md), { fileType: "md" } as any);
const astEn = await OfficeParser.parseOffice(Buffer.from(mdEn), { fileType: "md" } as any);
for (const fmt of ["docx", "xlsx", "pptx", "pdf", "odt", "html", "rtf", "epub"]) {
	const out = await OfficeGenerator.generate((fmt === "pdf" ? astEn : ast) as any, fmt as any, (fmt === "pdf" ? { pdfConfig: { engine: "native" } } : undefined) as any);
	const value = (out as any).value;
	writeFileSync(join(dir, `report.${fmt}`), typeof value === "string" ? value : Buffer.from(value));
}
writeFileSync(join(dir, "notes.md"), md);
writeFileSync(join(dir, "data.csv"), "name,qty\nTrà sữa,120\nBánh mì,85\n");
writeFileSync(join(dir, "script.ps1"), "Get-Process | Select-Object -First 3\n");
writeFileSync(join(dir, "big.txt"), "Dòng ".repeat(5000));
writeFileSync(join(dir, "bundle.zip"), zipSync({ "a.txt": strToU8("hello"), "img/b.png": new Uint8Array(200) }));
writeFileSync(join(dir, "tool.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]));
writeFileSync(join(dir, "song.mp3"), Buffer.alloc(1000));

const noVision = async () => "(vision stub)";
const read = (name: string, offset?: number) => readAnyFile(join(dir, name), { offset }, noVision);

for (const fmt of ["docx", "xlsx", "pptx", "pdf", "odt", "html", "rtf", "epub"]) {
	const r = await read(`report.${fmt}`);
	assert.equal(r.kind, "document", fmt);
	// Vietnamese text and the table content must survive the round trip.
	assert.match(r.text, fmt === "pdf" ? /Milk tea/ : /Trà sữa/, `${fmt}: ${r.text.slice(0, 300)}`);
	assert.doesNotMatch(r.text, /IsLinearized|{#/, `${fmt} noise: ${r.text.slice(0, 200)}`);
	assert.match(r.text, /120/, fmt);
	console.log(`✓ ${fmt.padEnd(5)} ${r.text.split("\n")[0]}`);
}
for (const [name, kind, needle] of [
	["notes.md", "text", /Doanh thu/],
	["data.csv", "text", /Bánh mì,85/],
	["script.ps1", "text", /Get-Process/],
	["bundle.zip", "archive", /img\/b\.png/],
	["tool.bin", "binary", /binary file/],
	["song.mp3", "media", /can't listen/],
] as const) {
	const r = await read(name);
	assert.equal(r.kind, kind, name);
	assert.match(r.text, needle, `${name}: ${r.text}`);
	console.log(`✓ ${name.padEnd(10)} ${kind}`);
}

// paging: first page points at the next offset, second page continues from it
const p1 = await read("big.txt");
const next = Number(/offset (\d+)/.exec(p1.text)?.[1]);
assert.equal(next, 6000);
const p2 = await read("big.txt", next);
assert.match(p2.text, /chars 6000–12000 of 25000/);
console.log("✓ long files are paged");

assert.equal(isSecretPath("C:\\Users\\you\\.ssh\\id_rsa"), true);
assert.equal(isSecretPath("C:\\Users\\you\\Documents\\vault.kdbx"), true);
assert.equal(isSecretPath("C:\\proj\\.env"), true);
assert.equal(isSecretPath("C:\\proj\\.env.example"), false);
assert.equal(isSecretPath("C:\\Users\\you\\Documents\\report.pdf"), false);
assert.equal(fileKind("Dockerfile"), "text");
console.log("✓ secret files are refused");

if (process.argv.includes("--vision")) {
	const img = new URL("../sprites/aza/hi/hi_2.png", import.meta.url);
	const r = await readAnyFile(img.pathname.replace(/^\/([A-Z]:)/, "$1"), { question: "Who is in this picture and what is she doing?" }, (b64, q) =>
		ollamaChat("http://127.0.0.1:11434", process.env.MAI_VISION_MODEL ?? "mai-brain", [{ role: "user", content: q, images: [b64] }]),
	);
	console.log(`✓ image via vision model: ${r.text.split("\n").slice(1).join(" ").slice(0, 200)}`);
}
console.log("all file-reading tests passed");
