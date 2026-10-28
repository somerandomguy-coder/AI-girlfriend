// Offline tests for exploring/editing files. Usage: npx tsx scripts/fsops-test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdits, backupFile, findAnchorLine, findFiles, folderTree, globToRegExp, insertAtLine, miniDiff, planEdit, planInsert, planWrite, readLines, searchFiles } from "../src/core/fsops.js";

const root = mkdtempSync(join(tmpdir(), "mai-fsops-"));
const mk = (rel: string, body: string | Buffer) => {
	mkdirSync(join(root, rel, ".."), { recursive: true });
	writeFileSync(join(root, rel), body);
};
mk("notes/todo.md", "# Việc cần làm\n- mua sữa\n- gọi mẹ\n");
mk("notes/old/2025.md", "năm cũ\n");
mk("app/src/main.ts", "const a = 1;\nconst b = 2;\nexport { a, b };\n");
mk("app/node_modules/lib/index.js", "const secret = 'node_modules should be skipped';\n");
mk("app/.venv/x.py", "print('skip me')\n");
mk("windows.txt", "line one\r\nline two\r\n");
mk("bom.txt", "﻿hello\n");
mk("photo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));

// globs
assert.ok(globToRegExp("*.md").test("notes/old/2025.md"));
assert.ok(!globToRegExp("notes/*.md").test("notes/old/2025.md"));
assert.ok(globToRegExp("notes/**/*.md").test("notes/old/2025.md"));
console.log("✓ globs");

// find skips heavy folders unless asked
const f1 = findFiles(root, "*.js");
assert.equal(f1.total, 0);
assert.ok(f1.skipped.some((s) => s.includes("node_modules")));
assert.equal(findFiles(root, "*.js", { includeHeavy: true }).total, 1);
assert.equal(findFiles(root, "*.md").total, 2);
console.log("✓ find_files skips node_modules / .venv unless asked");

// search
const s1 = searchFiles(root, "gọi mẹ");
assert.deepEqual(s1.hits.map((h) => [h.file.replace(/\\/g, "/"), h.line]), [["notes/todo.md", 3]]);
assert.equal(searchFiles(root, "skip").hits.length, 0, "heavy dirs not searched");
assert.equal(searchFiles(root, "/const [ab] =/").hits.length, 2);
assert.equal(searchFiles(root, "PNG").hits.length, 0, "binary skipped");
console.log("✓ search_files: text, regex, skips binary and heavy folders");

// tree
const tree = folderTree(root, 2);
assert.match(tree, /notes\/ {2}\(2 items\)/);
assert.match(tree, /skipped heavy folders: .*node_modules/);
console.log("✓ folder_tree");

// read by lines
const r = readLines(join(root, "app/src/main.ts"), 2, 3);
assert.equal(r.text, "2│ const b = 2;\n3│ export { a, b };");
assert.equal(r.total, 4);
console.log("✓ read lines with numbers");

// edits
assert.equal(applyEdits("a\nb\nc\n", [{ oldText: "b", newText: "B" }, { oldText: "c", newText: "C" }]), "a\nB\nC\n");
assert.throws(() => applyEdits("x x", [{ oldText: "x", newText: "y" }]), /appears 2 times/);
assert.throws(() => applyEdits("abc", [{ oldText: "zzz", newText: "y" }]), /not found/);
assert.throws(() => applyEdits("abcdef", [{ oldText: "abc", newText: "1" }, { oldText: "cde", newText: "2" }]), /overlap/);
assert.equal(insertAtLine("1\n2\n3", 1, "new"), "1\nnew\n2\n3");
assert.equal(insertAtLine("1\n2\n3", 1, "new", "before"), "new\n1\n2\n3");
assert.equal(insertAtLine("1\n2", 99, "end"), "1\n2\nend");
assert.match(miniDiff("a\nb\nc", "a\nB\nc"), /- b\n\+ B/);
console.log("✓ exact edits, uniqueness, overlap, insert, diff");

// line endings and BOM survive edits; binary refused
const win = join(root, "windows.txt");
planEdit(win, [{ oldText: "line two", newText: "line 2" }]).commit();
assert.equal(readFileSync(win, "utf8"), "line one\r\nline 2\r\n");
const bom = join(root, "bom.txt");
planInsert(bom, 1, "world", "after").commit();
assert.equal(readFileSync(bom, "utf8"), "﻿hello\nworld\n");
assert.throws(() => planEdit(join(root, "photo.png"), [{ oldText: "PNG", newText: "x" }]), /binary/);
console.log("✓ keeps CRLF and BOM; refuses binary files");

// write modes
const todo = join(root, "notes/todo.md");
assert.throws(() => planWrite(todo, "x", "create"), /already exists/);
planWrite(todo, "- tập thể dục", "append").commit();
assert.equal(readFileSync(todo, "utf8"), "# Việc cần làm\n- mua sữa\n- gọi mẹ\n- tập thể dục");
const fresh = join(root, "new/dir/plan.md");
planWrite(fresh, "hello", "create").commit();
assert.equal(readFileSync(fresh, "utf8"), "hello");
console.log("✓ write_file create / append / refuses accidental overwrite");

// backups
const bdir = join(root, "_backups");
const b = backupFile(todo, bdir)!;
assert.equal(readFileSync(b, "utf8"), readFileSync(todo, "utf8"));
assert.equal(readdirSync(bdir).length, 1);
console.log("✓ backups");

// insert by anchor text (more reliable than line numbers for small models)
assert.equal(findAnchorLine("a\n- gọi mẹ\nb", "- gọi mẹ"), 2);
assert.throws(() => findAnchorLine("x\nx", "x"), /on 2 lines/);
assert.throws(() => findAnchorLine("x", "zz"), /No line contains/);
const anchored = join(root, "anchor.md");
writeFileSync(anchored, "- mua sữa\n- gọi mẹ\n- nộp báo cáo\n");
planInsert(anchored, { anchor: "gọi mẹ" }, "- đi chợ", "after").commit();
assert.equal(readFileSync(anchored, "utf8"), "- mua sữa\n- gọi mẹ\n- đi chợ\n- nộp báo cáo\n");
console.log("✓ insert by anchor");
console.log("all file-ops tests passed");
