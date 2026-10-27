# Customizing Mai

Everything that makes her *her* lives in your data folder, not in the code:

```
%USERPROFILE%\.mai-companion\
  config.json          settings (also editable in ⚙ Settings)
  persona\             her personality + memory, a private git repo
    SOUL.md            who she is, how she talks (the part below <!-- LOCKED --> is safety rules)
    USER.md            facts about you she has learned
    MEMORY.md          her notes: promises, open loops, inside jokes
    HEARTBEAT.md       what she checks when she wakes up on her own
  sprites\<set>\       your own sprite sets (see SPRITES.md)
  state\               calendar, todos, quests, needs, mood, chat log, voice clip, logs
  sessions\            the conversation transcript (auto-compacted)
```

Back her up by copying this folder. Start completely fresh by renaming it. Set `MAI_HOME` to keep several
separate Mais (e.g. one for testing).

## Personality

Open **⚙ Settings → Persona**, pick a file, edit, and press **Save version**. Every save (yours or hers) is a
version: **History & rollback** shows the diff and restores any version in one click. You can also edit the
files in any editor; she reads them fresh before every reply.

- **Character:** rewrite the top of `SOUL.md`. Keep the structure (*How I talk*, *What I care about*, *Moods*,
  *Side quests*); small models follow short, concrete bullets better than long prose.
- **Name:** change it in `SOUL.md` ("I'm **Mai**"). The window title and tray still say Mai; search the code for
  `"Mai"` if you want those changed too.
- **Vietnamese pronouns:** she uses chị/em by default (she's the older one). Change the *How I talk* bullet,
  e.g. to "em" for herself and "anh" for him.
- **How often she talks on her own:** `HEARTBEAT.md` (what she checks) plus Settings → Heartbeat (interval,
  daily cap, quiet hours, spontaneity).
- **The LOCKED section** (no explicit content, no guilt-tripping, honesty about being an AI, crisis helplines)
  can only be edited by you, never by her own tools. Please keep it.

She also edits these files herself (`remember`, `edit_persona`), e.g. when you say "call me X from now on".
Each of her edits is a commit labelled `[mai]` with her reason.

## Voice

Settings → Voice. Engines, best first:

| Engine | Needs | Sounds like |
|---|---|---|
| `voxcpm2` | NVIDIA GPU, ~3 GB VRAM (setup's 32gb profile) | Most expressive: each mood has a style prompt (teasing, stern, sleepy…). Clones one reference clip so she's always the same person |
| `vieneu` | CPU is fine | Natural Vietnamese + English, per-mood delivery, occasional laugh / sigh / ahem |
| `edge` | internet | Microsoft neural voices, mood-based pitch and rate. Also the automatic fallback |

- **Change her VieNeu voice:** Settings → *VieNeu voice*. 11 female + 1 male presets are downloaded; listen to
  them with `npx tsx scripts/tts-test.ts <voice-id>` while Mai is running.
- **Give her a custom voice (VoxCPM2):** record or find a clean 5–10 s WAV of one person talking, then put its
  path in *VoxCPM2: her voice clip*. Without it, a clip from her VieNeu voice is generated once
  (`state\mai-voice-<voice>.wav`; delete it to regenerate).
- **Tune the moods:** `VIENEU_MOOD` (sampling and cues) and `VOX_STYLE` (style prompts) at the top of
  `src/core/tts.ts`.
- **Get VoxCPM2 on a smaller GPU anyway:** `powershell -File scripts\setup-vieneu.ps1 -Cuda -Expressive`, then
  pick `voxcpm2`. It shares VRAM with the brain, so watch for slowdowns.

## Models

Setup creates two Ollama models:
- **`mai-brain`**: the chat model, with vision for screen peeks.
- **`mai-helper`**: a small model for quick checks.

Each is a stock model wrapped with a context size; see `ollama\*.Modelfile`.

- **Try a different brain:** `ollama pull <tag>`, then either set *Main model* in Settings, or point
  `ollama\mai-brain.Modelfile` at it and run `ollama create mai-brain -f ollama\mai-brain.Modelfile`.
- **Which models fit a GPU?** Ask her ("what model fits a 5090?") or read `catalog/models.json`.
- **Thinking mode** (Settings → Brain) makes some models smarter but 3–5× slower, and they sometimes think
  until they run out of tokens. Leave it off for chat.

## What she's allowed to touch

- **Folders she may look in / move files in:** Settings → Hands → *Folders she may touch*. She reads files inside them freely; reading anything outside asks you first. Password stores, SSH keys and `.env` files are never opened.
- **File moves and PowerShell changes** always ask you first; set *Ask before running* to `always` to be asked
  about read-only commands too, or switch PowerShell off.
- **Screen:** *Notice which app is open* (window titles, local only) and *Allow screen peeks* (screenshot → local
  vision model → deleted). *Never look at* lists window titles she ignores (banking, password managers…).

## Her needs and quests

- **Needs** (🍙 ⚡ 💬 🎲 🌿) and how fast they change: `src/core/needs.ts`, `tick()` and `describe()`.
- **Side quest ideas and spontaneous behaviours:** `SPONTANEOUS` in `src/core/heartbeat.ts`.

Not comfortable editing code? Ask an AI assistant in this folder; AGENTS.md tells it where things are and how to
test.
