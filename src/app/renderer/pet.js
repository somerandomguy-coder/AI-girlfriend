// Desktop pet renderer: sprite animation, speech bubble, input, and voice playback.
const $ = (id) => document.getElementById(id);
const avatar = $("avatar");
const bubble = $("bubble");
const bubbleText = $("bubble-text");
const bubbleMeta = $("bubble-meta");
const logEl = $("log");
const activity = $("activity");
const badge = $("mood-badge");
const hearts = $("hearts");

const MOOD_BADGE = { happy: "💗", proud: "✨", teasing: "😏", stern: "💢", angry: "💢", pouty: "😤", worried: "💧", sleepy: "💤", neutral: "" };
const TOOL_LABEL = {
  remember: "noting that down", edit_persona: "rewriting herself", read_persona_file: "checking her notes",
  calendar_add: "writing in the calendar", calendar_list: "checking the calendar", calendar_remove: "crossing it out",
  quest_give: "inventing a quest", quest_check: "inspecting your work", quest_resolve: "judging you",
  look_at_screen: "peeking at your screen 👀", system_info: "checking your PC", recommend_models: "consulting the cookbook",
  list_folder: "digging through folders", move_file: "moving files", open: "opening it",
  todo_add: "writing your todo", todo_list: "checking your todos", todo_complete: "ticking it off", todo_remove: "crossing it out",
  adjust_needs: "having feelings", run_powershell: "running a command",
};

let sprite = null;
let base = "";
let activityState = "idle"; // idle | thinking | tool | talking
let toolName = "";
let mood = "neutral";
let moodHoldUntil = 0;
let speaking = false;
let frameTimer = null;
let currentKey = "";
let hideTimer = null;
let muted = false;
let pose = { mode: "roam", behaviour: "idle", facing: "left" };
let loading = false;
/** A short one-off animation (eating after 🍙, flinching after 👉) that wins over everything but dragging. */
let flash = null;
function playFlash(names, ms) {
  flash = { state: pick(...names), until: Date.now() + ms };
  refresh();
  setTimeout(refresh, ms + 20);
}

/** First state the sprite set actually has; sets without e.g. "walk" or "yawn" fall back gracefully. */
function pick(...names) {
  return names.find((n) => sprite.states[n]) || "idle";
}

// ---------- sprite animation ----------
function stateFor() {
  if (pose.behaviour === "held") return pick("held", "surprised", "upset");
  if (pose.behaviour === "fall") return pick("fall", "surprised", "upset");
  if (flash && Date.now() < flash.until) return flash.state;
  if (speaking || activityState === "talking") return "talk";
  if (loading) return pick("yawn", "sleep", "think");
  if (pose.behaviour === "walk") return pick("walk", "idle");
  if (activityState === "tool") return (sprite.tools && sprite.tools[toolName]) || "tool";
  if (activityState === "thinking") return "think";
  // Show the mood pose for a few seconds after she speaks, then settle to idle (the badge keeps the mood visible).
  // A set may ship a state named after the mood ("pouty", "angry"); otherwise use its "moods" mapping.
  if (Date.now() < moodHoldUntil) return pick(mood, (sprite.moods && sprite.moods[mood]) || "idle");
  // Very late and drained: she dozes off (if the set has a sleep animation).
  if (lastNeeds && lastNeeds.energy < 20 && pose.behaviour === "idle") return pick("sleep", "idle");
  return "idle";
}

function play(stateName) {
  const st = sprite.states[stateName] || sprite.states.idle;
  const key = stateName;
  if (key === currentKey) return;
  currentKey = key;
  clearTimeout(frameTimer);
  let i = 0;
  const frames = st.frames;
  const tick = () => {
    if (st.blink && stateName === "idle") {
      avatar.src = base + frames[0];
      frameTimer = setTimeout(() => {
        avatar.src = base + st.blink;
        frameTimer = setTimeout(tick, 140);
      }, 2500 + Math.random() * 3500);
      return;
    }
    const idx = st.random ? Math.floor(Math.random() * frames.length) : i++ % frames.length;
    avatar.src = base + frames[idx];
    frameTimer = setTimeout(tick, 1000 / (st.fps || 4));
  };
  tick();
}

function refresh() {
  if (sprite) play(stateFor());
}
setInterval(refresh, 500);

// ---------- bubble & log ----------
function showBubble(text, { proactive = false, meta = "", streaming = false } = {}) {
  clearTimeout(hideTimer);
  // renderMarkdown escapes all HTML first, so model text can't inject markup.
  bubbleText.innerHTML = window.renderMarkdown(text, streaming);
  bubbleMeta.textContent = meta;
  bubble.classList.toggle("proactive", proactive);
  bubble.classList.remove("hidden");
  bubbleText.scrollTop = bubbleText.scrollHeight;
}
function scheduleHide(ms = 25000) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => bubble.classList.add("hidden"), ms);
}
function addLog(line) {
  const div = document.createElement("div");
  div.className = `line ${line.role}`;
  if (line.role === "mai") div.innerHTML = window.renderMarkdown(line.text);
  else div.textContent = line.text;
  const small = document.createElement("small");
  small.textContent = `${new Date(line.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${line.proactive ? " · on her own" : ""}`;
  div.prepend(small);
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
function setMood(m) {
  mood = m;
  moodHoldUntil = Date.now() + 8000;
  badge.textContent = MOOD_BADGE[m] || "";
  badge.classList.toggle("show", !!MOOD_BADGE[m]);
  refresh();
}
function setHearts(affection) {
  const n = Math.max(0, Math.min(5, Math.round((affection + 20) / 24)));
  hearts.textContent = "♥".repeat(n) + "♡".repeat(5 - n);
  hearts.title = `affection ${Math.round(affection)}/100`;
}

// ---------- brain events ----------
let streamingText = "";
window.mai.onEvent((e) => {
  switch (e.type) {
    case "state":
      if (e.state === "loading") { setLoading(true); break; }
      if (loading && e.state === "idle") setLoading(false);
      activityState = e.state;
      if (e.state === "thinking") { streamingText = ""; activity.textContent = "…"; activity.classList.remove("hidden"); }
      if (e.state === "idle") activity.classList.add("hidden");
      refresh();
      break;
    case "delta":
      activity.classList.add("hidden");
      streamingText += e.text;
      showBubble(streamingText, { streaming: true });
      break;
    case "say":
      activity.classList.add("hidden");
      // She has something to say: come back from the floating head and show it.
      if ($("talk").dataset.panel) $("talk").dataset.panel = "";
      showBubble(e.text, { proactive: e.proactive, meta: e.proactive ? "she said this on her own" : "" });
      addLog({ role: "mai", text: e.text, ts: Date.now(), proactive: e.proactive });
      streamingText = "";
      if (muted) scheduleHide();
      break;
    case "mood":
      setMood(e.mood);
      setHearts(e.affection);
      break;
    case "needs":
      setNeeds(e.needs);
      break;
    case "planner_changed":
      if ($("talk").dataset.panel === "planner") void renderPlanner();
      break;
    case "tool":
      if (e.phase === "start") {
        toolName = e.name;
        activity.textContent = TOOL_LABEL[e.name] || e.name;
        activity.classList.remove("hidden");
      } else if (e.isError) {
        activity.textContent = `${TOOL_LABEL[e.name] || e.name} — oops, retrying`;
      }
      refresh();
      break;
    case "error":
      showBubble(`⚠ ${e.message}`, { meta: "system" });
      bubbleText.classList.add("error");
      setTimeout(() => bubbleText.classList.remove("error"), 8000);
      scheduleHide(15000);
      break;
  }
});

// ---------- voice ----------
// Sentences arrive one by one while she's still writing; play them back to back.
const audio = new Audio();
let speechQueue = [];
function playNext() {
  const s = speechQueue.shift();
  if (!s) { speaking = false; refresh(); scheduleHide(); return; }
  audio.src = `data:${s.mime};base64,${s.audio}`;
  audio.play().catch(() => playNext());
}
function stopSpeech() {
  speechQueue = [];
  audio.pause();
}
window.mai.onSpeech((s) => {
  if (muted) return;
  speechQueue.push(s);
  if (audio.paused || audio.ended) playNext();
});
window.mai.onSpeechStop(stopSpeech);
audio.addEventListener("play", () => { speaking = true; refresh(); });
audio.addEventListener("ended", playNext);
audio.addEventListener("pause", () => { if (!audio.ended) { speaking = false; refresh(); } });

// ---------- input & toolbar ----------
$("say-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = $("say").value.trim();
  if (!text) return;
  $("say").value = "";
  growInput();
  stopSpeech();
  // Sending a message always brings the conversation back into view.
  setPanel(null);
  addLog({ role: "me", text, ts: Date.now() });
  showBubble("…", { meta: `you: ${text.slice(0, 60)}` });
  await window.mai.send(text);
});
window.mai.onFocusInput(() => sayBox.focus());
// ---------- panels above her: speech bubble (default), chat history, planner ----------
function setPanel(name) {
  const talk = $("talk");
  talk.dataset.panel = talk.dataset.panel === name ? "" : name || "";
  if (talk.dataset.panel === "log") logEl.scrollTop = logEl.scrollHeight;
  if (talk.dataset.panel === "planner") void renderPlanner();
}
$("btn-log").addEventListener("click", () => setPanel("log"));
$("btn-planner").addEventListener("click", () => setPanel("planner"));

// ---------- planner: his todos + the next 7 days of her calendar ----------
function dueChip(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  const hasTime = /T\d/.test(iso);
  const time = hasTime ? " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const label = diff === 0 ? "today" : diff === 1 ? "tomorrow" : diff === -1 ? "yesterday" : d.toLocaleDateString([], { day: "numeric", month: "short" });
  const span = document.createElement("span");
  span.className = "chip" + ((hasTime ? d < new Date() : diff < 0) ? " overdue" : "");
  span.textContent = label + time;
  return span;
}
function xButton(title, onClick) {
  const b = document.createElement("button");
  b.className = "x"; b.type = "button"; b.title = title; b.textContent = "×";
  b.addEventListener("click", onClick);
  return b;
}
function emptyRow(text) {
  const li = document.createElement("li");
  li.className = "empty"; li.textContent = text;
  return li;
}
async function renderPlanner() {
  const { events, todos } = await window.mai.planner();
  const tl = $("todo-list");
  tl.replaceChildren();
  if (!todos.length) tl.append(emptyRow("Nothing yet. Add one, or tell her what you need to do."));
  for (const t of todos) {
    const li = document.createElement("li");
    li.className = t.done ? "done" : "";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = t.done; cb.title = t.done ? "Mark as not done" : "Done!";
    cb.addEventListener("change", () => window.mai.todoToggle(t.id, cb.checked));
    const title = document.createElement("span");
    title.className = "title"; title.textContent = t.title + (t.priority === "high" ? " ❗" : "");
    li.append(cb, title);
    if (t.due && !t.done) li.append(dueChip(t.due));
    if (t.createdBy === "mai") {
      const m = document.createElement("span");
      m.className = "by-mai"; m.title = "She added this"; m.textContent = "✦";
      li.append(m);
    }
    li.append(xButton("Delete", () => window.mai.todoRemove(t.id)));
    tl.append(li);
  }
  const el = $("event-list");
  el.replaceChildren();
  if (!events.length) el.append(emptyRow("Nothing scheduled."));
  let lastDay = "";
  for (const e of events) {
    const d = new Date(e.start);
    const day = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
    if (day !== lastDay) {
      const h = document.createElement("li");
      h.className = "day"; h.textContent = day;
      el.append(h);
      lastDay = day;
    }
    const li = document.createElement("li");
    const time = document.createElement("span");
    time.className = "chip"; time.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const title = document.createElement("span");
    title.className = "title"; title.textContent = e.title + (e.repeat ? ` (${e.repeat})` : "");
    li.append(time, title, xButton("Delete event", () => window.mai.eventRemove(e.id)));
    el.append(li);
  }
}
$("todo-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = $("todo-new");
  const title = input.value.trim();
  if (!title) return;
  input.value = "";
  await window.mai.todoAdd(title);
});

// ---------- needs bars ("good when full": hunger and worry are shown inverted) ----------
const NEEDS = [
  { key: "hunger", icon: "🍙", invert: true, name: "Full", low: "hungry" },
  { key: "energy", icon: "⚡", name: "Energy", low: "sleepy" },
  { key: "social", icon: "💬", name: "Social", low: "lonely" },
  { key: "fun", icon: "🎲", name: "Fun", low: "bored" },
  { key: "worry", icon: "🌿", invert: true, name: "Calm", low: "worried about you" },
];
let lastNeeds = null;
function setNeeds(n) {
  lastNeeds = n;
  refresh();
  const box = $("needs");
  box.replaceChildren();
  for (const d of NEEDS) {
    const v = Math.round(d.invert ? 100 - n[d.key] : n[d.key]);
    const row = document.createElement("div");
    row.className = "need" + (v <= 25 ? " low" : "");
    row.title = `${d.name}: ${v}/100` + (v <= 25 ? ` (she is ${d.low})` : "");
    const icon = document.createElement("span");
    icon.textContent = d.icon;
    const bar = document.createElement("span");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.style.width = `${v}%`;
    bar.append(fill);
    row.append(icon, bar);
    box.append(row);
  }
}

// ---------- where she is: roaming on the desktop, or the full chat window ----------
function applyPose(p) {
  pose = p;
  const b = document.body.classList;
  b.toggle("mode-roam", p.mode === "roam");
  b.toggle("walking", p.behaviour === "walk");
  b.toggle("held", p.behaviour === "held");
  b.toggle("falling", p.behaviour === "fall");
  b.toggle("facing-right", p.facing === "right");
  refresh();
}
window.mai.onPose(applyPose);

function setLoading(on) {
  loading = on;
  if (on) {
    activity.textContent = "waking up… 🥱";
    activity.classList.remove("hidden");
    badge.textContent = "💤";
    badge.classList.add("show");
  } else {
    activity.classList.add("hidden");
    badge.classList.toggle("show", !!MOOD_BADGE[mood]);
    badge.textContent = MOOD_BADGE[mood] || "";
  }
  refresh();
}


// ---------- input box: grows with the text; Enter sends, Shift+Enter is a new line ----------
const sayBox = $("say");
function growInput() {
  sayBox.style.height = "auto";
  sayBox.style.height = `${Math.min(sayBox.scrollHeight + 4, 140)}px`;
}
sayBox.addEventListener("input", growInput);
sayBox.addEventListener("keydown", (ev) => {
  // isComposing: don't send while a Vietnamese IME (Telex/VNI) is still composing a character.
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    $("say-form").requestSubmit();
  }
});

// ---------- click-through: empty, transparent parts of the window don't block the desktop ----------
let clickThrough = null;
let dragging = null;
function setClickThrough(on) {
  if (on === clickThrough) return;
  clickThrough = on;
  window.mai.setClickThrough(on);
}
document.addEventListener("mousemove", (ev) => {
  if (dragging) return;
  const solid = ev.target.closest && ev.target.closest("#bubble:not(.hidden), #talk[data-panel=log] #log, #talk[data-panel=planner] #planner, #activity:not(.hidden), #avatar, #mood-badge, #needs, #controls");
  setClickThrough(!solid);
});
document.addEventListener("mouseleave", () => { if (!dragging) setClickThrough(true); });

// ---------- drag her around by the sprite (a click without moving opens the chat box) ----------
avatar.addEventListener("pointerdown", (ev) => {
  dragging = { x: ev.screenX, y: ev.screenY, moved: 0, grabbed: false };
  avatar.setPointerCapture(ev.pointerId);
  avatar.style.cursor = "grabbing";
});
avatar.addEventListener("pointermove", (ev) => {
  if (!dragging) return;
  const dx = ev.screenX - dragging.x, dy = ev.screenY - dragging.y;
  if (!dx && !dy) return;
  dragging.moved += Math.abs(dx) + Math.abs(dy);
  // Only count it as picking her up once the pointer really moves (a click shouldn't make her flail).
  if (!dragging.grabbed && dragging.moved >= 4) { dragging.grabbed = true; window.mai.grab(); }
  dragging.x = ev.screenX;
  dragging.y = ev.screenY;
  window.mai.moveBy(dx, dy);
});
avatar.addEventListener("pointerup", (ev) => {
  const wasClick = dragging && !dragging.grabbed;
  const wasGrabbed = dragging && dragging.grabbed;
  dragging = null;
  avatar.releasePointerCapture(ev.pointerId);
  avatar.style.cursor = "";
  if (wasGrabbed) window.mai.release();
  else if (wasClick && pose.mode === "roam") window.mai.setMode("chat");
  else if (wasClick) sayBox.focus();
});
$("btn-mute").addEventListener("click", async () => {
  muted = !muted;
  if (muted) stopSpeech();
  $("btn-mute").textContent = muted ? "🔇" : "🔊";
  await window.mai.setMuted(muted);
});
$("btn-wake").addEventListener("click", () => { playFlash(["poked", "surprised", "upset"], 900); window.mai.wake(); });
$("btn-settings").addEventListener("click", () => window.mai.openSettings());
$("btn-hide").addEventListener("click", () => window.mai.setMode("roam"));
$("btn-feed").addEventListener("click", () => { playFlash(["eat", "hi"], 2500); window.mai.feed(); });
bubble.addEventListener("click", () => scheduleHide(60000));
// Links open in his browser, never inside the pet window.
document.addEventListener("click", (ev) => {
  const a = ev.target.closest && ev.target.closest("a.md-link");
  if (!a) return;
  ev.preventDefault();
  window.mai.openLink(a.getAttribute("href"));
});

// ---------- boot ----------
(async () => {
  const s = await window.mai.sprite();
  sprite = s.manifest;
  base = s.base;
  if (sprite.size) document.getElementById("body").style.height = `${sprite.size}px`;
  avatar.classList.toggle("smooth", sprite.pixelated === false);
  refresh();
  for (const line of await window.mai.history()) addLog(line);
  const st = await window.mai.status();
  setHearts(st.mood.affection);
  if (st.needs) setNeeds(st.needs);
  if (st.loading) setLoading(true);
  muted = st.muted;
  $("btn-mute").textContent = muted ? "🔇" : "🔊";
})();
