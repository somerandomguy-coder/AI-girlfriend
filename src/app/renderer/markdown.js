// Tiny, safe Markdown → HTML for chat bubbles. Everything is HTML-escaped first, then only a small
// whitelist is turned into tags: **bold**, *italic*, ~~strike~~, `code`, ``` blocks, [links](https://…),
// headings, bullet/numbered lists, > quotes. Unclosed markers (mid-stream) are hidden rather than shown raw.
(function (root) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = s
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" class="md-link">${t}</a>`)
      .replace(/\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
      .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  }

  /** While streaming, a half-written "**bold" would flash asterisks; drop the dangling marker. */
  function closeDangling(src) {
    for (const m of ["**", "~~", "`"]) {
      const n = src.split(m).length - 1;
      if (n % 2 === 1) {
        const i = src.lastIndexOf(m);
        src = src.slice(0, i) + src.slice(i + m.length);
      }
    }
    return src;
  }

  function renderMarkdown(src, streaming) {
    if (streaming) {
      const fences = (src.match(/```/g) || []).length;
      if (fences % 2 === 1) src += "\n```";
      else src = closeDangling(src);
    }
    const out = [];
    const parts = src.split(/```[^\n]*\n?/);
    parts.forEach((part, idx) => {
      if (idx % 2 === 1) {
        out.push(`<pre><code>${esc(part.replace(/\n$/, ""))}</code></pre>`);
        return;
      }
      const lines = esc(part).split("\n");
      let list = null;
      const flush = () => {
        if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
        list = null;
      };
      for (const line of lines) {
        let m;
        if ((m = /^\s*[-*•+]\s+(.*)$/.exec(line))) {
          if (!list || list.tag !== "ul") { flush(); list = { tag: "ul", items: [] }; }
          list.items.push(m[1]);
        } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
          if (!list || list.tag !== "ol") { flush(); list = { tag: "ol", items: [] }; }
          list.items.push(m[1]);
        } else {
          flush();
          if ((m = /^#{1,6}\s+(.*)$/.exec(line))) out.push(`<p class="md-h">${inline(m[1])}</p>`);
          else if ((m = /^&gt;\s?(.*)$/.exec(line))) out.push(`<blockquote>${inline(m[1])}</blockquote>`);
          else if (line.trim() === "") out.push('<div class="md-gap"></div>');
          else out.push(`<p>${inline(line)}</p>`);
        }
      }
      flush();
    });
    // Collapse runs of blank-line spacers.
    return out.join("").replace(/(<div class="md-gap"><\/div>){2,}/g, '<div class="md-gap"></div>').replace(/^(<div class="md-gap"><\/div>)+|(<div class="md-gap"><\/div>)+$/g, "");
  }

  root.renderMarkdown = renderMarkdown;
})(globalThis);
