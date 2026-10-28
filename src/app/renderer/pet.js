// Desktop pet renderer: sprite animation, speech bubble, input, and voice playback.
const $ = (id) => document.getElementById(id);
const avatar = $("avatar");
const bubble = $("bubble");
const bubbleText = $("bubble-text");
const bubbleMeta = $("bubble-meta");
const logEl = $("log");
const logLines = $("log-lines");
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
  adjust_needs: "having feelings", run_powershell: "running a command", read_file: "reading your file 📄",
  folder_tree: "looking around the folder", find_files: "looking for files 🔎", search_files: "searching inside files 🔎",
  edit_file: "editing a file ✏️", insert_text: "adding lines ✏️", write_file: "writing a file ✏️",
  start_long_task: "asking to work on it", task_progress: "ticking off a step",
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
  const empty = logLines?.querySelector(".log-empty-hint");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = `line ${line.role}`;
  if (line.role === "mai") div.innerHTML = window.renderMarkdown(line.text);
  else div.textContent = line.text;
  const small = document.createElement("small");
  small.textContent = `${new Date(line.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${line.proactive ? " · on her own" : ""}`;
  div.prepend(small);
  const target = logLines || logEl;
  target.appendChild(div);
  target.scrollTop = target.scrollHeight;
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
    case "task":
      setTask(e.task);
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
  if (talk.dataset.panel === "log") {
    const target = logLines || logEl;
    target.scrollTop = target.scrollHeight;
  }
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

// ---------- work mode: a long task he approved, with progress and a stop button ----------
let taskDoneTimer = null;
function setTask(t) {
  const bar = $("taskbar");
  clearTimeout(taskDoneTimer);
  if (!t) { bar.classList.add("hidden"); return; }
  const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
  const label = { running: "🛠 Working", done: "✅ Done", stopped: "⏹ Stopped", out_of_budget: "⌛ Out of time" }[t.status] || t.status;
  $("task-text").textContent = `${label}: ${t.goal} · ${t.done}/${t.total}${t.status === "running" && t.next ? ` · next: ${t.next}` : ""}`;
  $("task-progress").firstElementChild.style.width = `${pct}%`;
  $("btn-stop-task").hidden = t.status !== "running";
  bar.classList.toggle("finished", t.status !== "running");
  bar.classList.remove("hidden");
  // Finished tasks stay visible for a minute, then the bar goes away.
  if (t.status !== "running") taskDoneTimer = setTimeout(() => bar.classList.add("hidden"), 60000);
}
$("btn-stop-task").addEventListener("click", () => window.mai.stopTask());

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

// ---------- Speech to Text (STT) (Vietnamese priority, English supported) ----------
const btnMic = $("btn-mic");
let isRecording = false;
let mediaRecorder = null;
let audioStream = null;
let audioChunks = [];
let micLang = "vi-VN"; // Priority Vietnamese

function updateMicUi(recording) {
  isRecording = recording;
  if (!btnMic) return;
  btnMic.classList.toggle("recording", recording);
  btnMic.textContent = recording ? "⏹️" : "🎙️";
  btnMic.title = recording
    ? "Recording (" + (micLang === "vi-VN" ? "Tiếng Việt" : "English") + ")… Click to finish"
    : "Voice typing (" + (micLang === "vi-VN" ? "Tiếng Việt" : "English") + ") · Right-click to switch language";
  if (recording) {
    sayBox.placeholder = "Listening (" + (micLang === "vi-VN" ? "Tiếng Việt" : "English") + ")…";
  } else {
    sayBox.placeholder = "Talk to her…";
  }
}

async function stopSTT() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch {}
  }
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop());
    audioStream = null;
  }
  updateMicUi(false);
}

// Chromium's SpeechRecognition needs Google's servers and an API key, which Electron doesn't have: it
// fails with "network" after you've already started talking. Mai always records locally instead and
// transcribes with Qwen3-ASR on her own voice server.
async function startSTT() {
  await startMediaRecorder();
}

/** Decode any recording the browser made (webm/opus…) and re-encode it as 16 kHz mono 16-bit WAV. */
async function toWav16k(blob) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const samples = (await offline.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); out.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, "data"); out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return { wav: new Uint8Array(out.buffer), seconds: decoded.duration };
}

async function startMediaRecorder() {
  try {
    const savedId = localStorage.getItem("mai_mic_device_id") || "";
    const constraints = {
      audio: savedId ? { deviceId: { exact: savedId } } : true,
    };
    audioStream = await navigator.mediaDevices.getUserMedia(constraints);
    audioChunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/ogg")
        ? "audio/ogg"
        : "audio/webm";
    mediaRecorder = new MediaRecorder(audioStream, { mimeType });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      if (audioStream) {
        audioStream.getTracks().forEach((t) => t.stop());
        audioStream = null;
      }
      if (!audioChunks.length) {
        updateMicUi(false);
        return;
      }
      const blob = new Blob(audioChunks, { type: mimeType });
      sayBox.placeholder = "Transcribing voice…";
      try {
        const { wav, seconds } = await toWav16k(blob);
        if (seconds < 0.4) throw new Error("That was too short. Hold the mic a little longer.");
        const text = await window.mai.transcribe({ wav, lang: micLang === "vi-VN" ? "vi" : "en" });
        if (text && text.trim()) {
          sayBox.value = (sayBox.value ? sayBox.value + " " : "") + text.trim();
          growInput();
          sayBox.focus();
        } else {
          showBubble("Could not detect speech. Try speaking closer to the microphone.", { meta: "mic" });
        }
      } catch (err) {
        // ipcRenderer wraps errors as "Error invoking remote method …: Error: <reason>"; show just the reason.
        showBubble("🎙️ " + String(err.message || err).replace(/^.*Error: /, ""), { meta: "voice input" });
      } finally {
        updateMicUi(false);
      }
    };
    updateMicUi(true);
    mediaRecorder.start();
  } catch (err) {
    updateMicUi(false);
    showBubble("Microphone error: " + err.message, { meta: "mic error" });
  }
}

if (btnMic) {
  btnMic.addEventListener("click", () => {
    if (isRecording) {
      stopSTT();
    } else {
      startSTT();
    }
  });
  // Right-click to switch between Tiếng Việt (priority default) and English
  btnMic.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    micLang = micLang === "vi-VN" ? "en-US" : "vi-VN";
    btnMic.title = "Voice typing (" + (micLang === "vi-VN" ? "Tiếng Việt" : "English") + ") · Right-click to switch language";
    showBubble("Switched voice input to: " + (micLang === "vi-VN" ? "Tiếng Việt 🇻🇳" : "English 🇬🇧"), { meta: "language" });
  });
}

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
  const solid = ev.target.closest && ev.target.closest("#bubble:not(.hidden), #talk[data-panel=log] #log, #talk[data-panel=planner] #planner, #taskbar:not(.hidden), #activity:not(.hidden), #avatar, #mood-badge, #needs, #controls");
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

// ---------- clear chat / reset brain ----------
let clearConfirmTimer = null;
const btnClearChat = $("btn-clear-chat");
if (btnClearChat) {
  btnClearChat.addEventListener("click", async () => {
    if (btnClearChat.dataset.confirm === "yes") {
      clearTimeout(clearConfirmTimer);
      delete btnClearChat.dataset.confirm;
      btnClearChat.textContent = "Clearing…";
      btnClearChat.disabled = true;
      try {
        await window.mai.clearChat();
        const target = logLines || logEl;
        target.replaceChildren();
        const hint = document.createElement("div");
        hint.className = "log-empty-hint";
        hint.textContent = "Chat history cleared & brain reset.\nLong-term memories in MEMORY.md are kept safe.";
        target.appendChild(hint);
        showBubble("All clean! What are we working on now?", { meta: "brain reset" });
      } finally {
        btnClearChat.textContent = "🧹 Clean brain";
        btnClearChat.disabled = false;
      }
      return;
    }
    btnClearChat.dataset.confirm = "yes";
    btnClearChat.textContent = "Confirm reset?";
    clearConfirmTimer = setTimeout(() => {
      delete btnClearChat.dataset.confirm;
      btnClearChat.textContent = "🧹 Clean brain";
    }, 4000);
  });
}

window.mai.onChatCleared?.(() => {
  const target = logLines || logEl;
  target.replaceChildren();
  const hint = document.createElement("div");
  hint.className = "log-empty-hint";
  hint.textContent = "Chat history cleared & brain reset.\nLong-term memories in MEMORY.md are kept safe.";
  target.appendChild(hint);
});

// ---------- boot ----------
(async () => {
  const s = await window.mai.sprite();
  sprite = s.manifest;
  base = s.base;
  if (sprite.size) document.getElementById("body").style.height = `${sprite.size}px`;
  avatar.classList.toggle("smooth", sprite.pixelated === false);
  refresh();
  const hist = await window.mai.history();
  if (!hist.length) {
    const hint = document.createElement("div");
    hint.className = "log-empty-hint";
    hint.textContent = "No messages yet. Say hi!\n(You can also ask her to remember things into MEMORY.md)";
    (logLines || logEl).appendChild(hint);
  } else {
    for (const line of hist) addLog(line);
  }
  const st = await window.mai.status();
  setHearts(st.mood.affection);
  if (st.needs) setNeeds(st.needs);
  if (st.loading) setLoading(true);
  if (st.task) setTask(st.task);
  muted = st.muted;
  $("btn-mute").textContent = muted ? "🔇" : "🔊";
})();
