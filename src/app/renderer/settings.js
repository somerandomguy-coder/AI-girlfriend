// Settings window: persona editor, version history with rollback, config, sprite picker.
const $ = (id) => document.getElementById(id);

// ---------- tabs ----------
document.querySelectorAll("nav [role=tab]").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
    document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === "history") loadHistory();
  }),
);

// ---------- persona ----------
let personaFiles = {};
let currentFile = "SOUL.md";
let dirty = false;
async function loadPersona() {
  personaFiles = await window.mai.personaFiles();
  const tabs = $("persona-file-tabs");
  tabs.innerHTML = "";
  for (const name of Object.keys(personaFiles)) {
    const b = document.createElement("button");
    b.textContent = name;
    b.setAttribute("aria-pressed", String(name === currentFile));
    b.addEventListener("click", () => {
      if (dirty && !confirm("Discard unsaved changes?")) return;
      currentFile = name;
      loadPersona();
    });
    tabs.appendChild(b);
  }
  $("persona-editor").value = personaFiles[currentFile] ?? "";
  dirty = false;
}
$("persona-editor").addEventListener("input", () => (dirty = true));
$("persona-save").addEventListener("click", async () => {
  const v = await window.mai.savePersona(currentFile, $("persona-editor").value);
  $("persona-status").textContent = v ? `Saved as version ${v.rev}.` : "No changes.";
  dirty = false;
});
window.mai.onPersonaChanged(() => {
  if (!dirty) loadPersona();
  if (!$("tab-history").hidden) loadHistory();
});

// ---------- history ----------
let selectedRev = null;
async function loadHistory() {
  const list = $("history-list");
  list.innerHTML = "";
  for (const v of await window.mai.personaHistory()) {
    const li = document.createElement("li");
    li.tabIndex = 0;
    li.innerHTML = `<div class="who"></div><div class="msg"></div>`;
    li.querySelector(".who").textContent = `${v.author === "mai" ? "she changed" : v.author} · ${new Date(v.date).toLocaleString()} · ${v.rev}`;
    li.querySelector(".who").classList.toggle("mai", v.author === "mai");
    li.querySelector(".msg").textContent = v.message;
    const pick = async () => {
      selectedRev = v.rev;
      list.querySelectorAll("li").forEach((x) => x.removeAttribute("aria-current"));
      li.setAttribute("aria-current", "true");
      renderDiff(await window.mai.personaDiff(v.rev));
      $("history-restore").disabled = false;
    };
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (e) => e.key === "Enter" && pick());
    list.appendChild(li);
  }
}
function renderDiff(text) {
  const pre = $("history-diff");
  pre.innerHTML = "";
  for (const line of text.split("\n")) {
    const span = document.createElement("span");
    if (line.startsWith("+") && !line.startsWith("+++")) span.className = "add";
    else if (line.startsWith("-") && !line.startsWith("---")) span.className = "del";
    span.textContent = `${line}\n`;
    pre.appendChild(span);
  }
}
$("history-restore").addEventListener("click", async () => {
  if (!selectedRev || !confirm(`Restore all persona files to how they were at ${selectedRev}?`)) return;
  const v = await window.mai.personaRollback(selectedRev);
  $("history-status").textContent = v ? `Restored (new version ${v.rev}).` : "Already at that version.";
  loadHistory();
  loadPersona();
});

// ---------- config ----------
const FIELDS = [
  ["Brain", [
    ["ollama.model", "Main model (Ollama tag)", "text"],
    ["ollama.smallModel", "Small helper model", "text"],
    ["ollama.contextWindow", "Context window (tokens)", "number"],
    ["ollama.think", "Let her think before answering (slower)", "bool"],
    ["ollama.baseUrl", "Ollama URL", "text"],
  ]],
  ["Heartbeat", [
    ["heartbeat.enabled", "She can talk on her own", "bool"],
    ["heartbeat.intervalMinutes", "Check-in every (minutes)", "number"],
    ["heartbeat.maxProactivePerDay", "Max unprompted messages / day", "number"],
    ["heartbeat.quietHours.start", "Quiet hours start (0-23)", "number"],
    ["heartbeat.quietHours.end", "Quiet hours end (0-23)", "number"],
    ["heartbeat.spontaneity", "Spontaneity (0-1)", "number"],
  ]],
  ["Eyes", [
    ["screen.watchWindows", "Notice which app is open", "bool"],
    ["screen.allowScreenshots", "Allow screen peeks (local vision model)", "bool"],
    ["screen.blocklist", "Never look at (one per line)", "lines"],
  ]],
  ["Voice", [
    ["tts.engine", "Engine (voxcpm2 = most expressive, needs GPU; vieneu = local, light)", ["voxcpm2", "vieneu", "edge", "openai", "none"]],
    ["tts.vieneu.voice", "VieNeu voice", "voices"],
    ["tts.vieneu.backend", "VieNeu runs on", ["cpu", "cuda"]],
    ["tts.vieneu.threads", "VieNeu CPU threads", "number"],
    ["tts.vieneu.autostart", "Start the voice server with Mai", "bool"],
    ["tts.voxcpm2.voiceRef", "VoxCPM2: her voice clip (WAV path, optional)", "text"],
    ["tts.voiceEn", "English voice (edge / fallback)", "text"],
    ["tts.voiceVi", "Vietnamese voice (edge / fallback)", "text"],
    ["tts.openai.baseUrl", "Local TTS server URL (openai engine)", "text"],
    ["tts.openai.model", "Local TTS model", "text"],
    ["tts.openai.voice", "Local TTS voice", "text"],
  ]],
  ["Hands", [
    ["quests.enabled", "Side quests", "bool"],
    ["quests.maxActive", "Max active quests", "number"],
    ["allowedRoots", "Folders she may touch (one per line)", "lines"],
    ["repair.useNeedle", "Needle tool-call repair", "bool"],
    ["agent.maxAutoContinues", "Max auto-continues per request", "number"],
    ["shell.enabled", "Let her use PowerShell (restart to apply)", "bool"],
    ["shell.approval", "Ask before running", ["writes", "always"]],
    ["shell.timeoutSeconds", "PowerShell timeout (seconds)", "number"],
  ]],
];
let cfg = null;
const get = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
const set = (o, p, v) => { const ks = p.split("."); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

async function loadConfig() {
  cfg = await window.mai.getConfig();
  const voices = await window.mai.ttsVoices();
  const form = $("config-form");
  form.innerHTML = "";
  for (const [legend, fields] of FIELDS) {
    const fs = document.createElement("fieldset");
    fs.innerHTML = `<legend></legend>`;
    fs.querySelector("legend").textContent = legend;
    for (const [path, label, type] of fields) {
      const l = document.createElement("label");
      let input;
      if (type === "bool") {
        l.className = "check";
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!get(cfg, path);
      } else if (Array.isArray(type)) {
        input = document.createElement("select");
        for (const opt of type) input.add(new Option(opt, opt, false, get(cfg, path) === opt));
      } else if (type === "voices") {
        input = document.createElement("select");
        if (!voices.length) input.add(new Option("(none downloaded: run scripts/setup-vieneu.ps1)", get(cfg, path)));
        for (const v of voices) input.add(new Option(v.label, v.id, false, get(cfg, path) === v.id));
      } else if (type === "lines") {
        input = document.createElement("textarea");
        input.className = "small";
        input.value = (get(cfg, path) || []).join("\n");
      } else {
        input = document.createElement("input");
        input.type = type;
        if (type === "number") input.step = "any";
        input.value = get(cfg, path) ?? "";
      }
      input.dataset.path = path;
      input.dataset.kind = Array.isArray(type) || type === "voices" ? "text" : type;
      const span = document.createElement("span");
      span.textContent = label;
      if (type === "bool") l.append(input, span);
      else l.append(span, input);
      fs.appendChild(l);
    }
    form.appendChild(fs);
  }
}
$("config-save").addEventListener("click", async () => {
  for (const el of $("config-form").querySelectorAll("[data-path]")) {
    const k = el.dataset.kind;
    const v = k === "bool" ? el.checked : k === "number" ? Number(el.value) : k === "lines" ? el.value.split("\n").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : el.value;
    set(cfg, el.dataset.path, v);
  }
  const r = await window.mai.saveConfig(cfg);
  $("config-status").textContent = r.note;
});

// ---------- sprites ----------
async function loadSprites() {
  const sel = $("sprite-select");
  sel.innerHTML = "";
  for (const s of await window.mai.spriteSets()) sel.add(new Option(s, s, false, s === cfg.spriteSet));
}
$("sprite-save").addEventListener("click", async () => {
  cfg.spriteSet = $("sprite-select").value;
  const r = await window.mai.saveConfig(cfg);
  $("sprite-status").textContent = r.ok ? "Look updated." : "";
});
$("open-sprites").addEventListener("click", () => window.mai.openPath("sprites"));
$("open-data").addEventListener("click", () => window.mai.openPath("data"));

(async () => {
  await loadPersona();
  await loadConfig();
  await loadSprites();
})();
