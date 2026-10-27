// Tests for the chat-bubble Markdown renderer. Usage: npx tsx scripts/markdown-test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const sandbox: { renderMarkdown?: (s: string, streaming?: boolean) => string } = {};
runInNewContext(readFileSync(new URL("../src/app/renderer/markdown.js", import.meta.url), "utf8"), { globalThis: sandbox });
const md = sandbox.renderMarkdown!;

const eq = (src: string, want: string, streaming = false) => assert.equal(md(src, streaming), want, `render(${JSON.stringify(src)})`);
eq("Có **chị đây** rồi.", "<p>Có <strong>chị đây</strong> rồi.</p>");
eq("Đi *ngủ* đi, ~~không~~ cãi.", "<p>Đi <em>ngủ</em> đi, <s>không</s> cãi.</p>");
eq("Run `Get-Process` now", "<p>Run <code>Get-Process</code> now</p>");
eq("Try **gemma4:26b-a4b-it-qat**", "<p>Try <strong>gemma4:26b-a4b-it-qat</strong></p>");
eq("file_name_here stays", "<p>file_name_here stays</p>");
eq("- one\n- **two**", "<ul><li>one</li><li><strong>two</strong></li></ul>");
eq("1. a\n2. b", "<ol><li>a</li><li>b</li></ol>");
eq("[docs](https://ollama.com)", '<p><a href="https://ollama.com" class="md-link">docs</a></p>');
eq("[bad](javascript:alert(1))", "<p>[bad](javascript:alert(1))</p>");
eq("<img src=x onerror=alert(1)>", "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
eq("**<b>x</b>**", "<p><strong>&lt;b&gt;x&lt;/b&gt;</strong></p>");
eq("```\nGet-Process | Sort CPU\n```", "<pre><code>Get-Process | Sort CPU</code></pre>");
eq("Hi\n\n\n\nthere", '<p>Hi</p><div class="md-gap"></div><p>there</p>');
// mid-stream: no raw markers flash
eq("Có **chị đ", "<p>Có chị đ</p>", true);
eq("```\nGet-Pro", "<pre><code>Get-Pro</code></pre>", true);
console.log("all markdown tests passed");
