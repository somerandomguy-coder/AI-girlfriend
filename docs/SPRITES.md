# Sprites: give Mai your own look

A **sprite set** is a folder of transparent PNG frames plus a `sprite.json` that says which frames make which
animation. The bundled set is `sprites/aza` (placeholder art by @shennguyenrs, MIT). Copy it and replace the
pictures.

```
%USERPROFILE%\.mai-companion\sprites\my-mai\
  sprite.json
  idle\idle.png, idle\idle_blink.png
  talk\talk_closed.png, talk_small.png, talk_mid.png, talk_wide.png
  walk\walk_1.png … walk_6.png
  …
```

Pick it in **Settings → Look**, then run the checker:

```powershell
node scripts/check-sprites.mjs "$env:USERPROFILE\.mai-companion\sprites\my-mai"
```

It catches missing files, frames without transparency, and mismatched canvas sizes, and lists which optional
states you haven't drawn yet (with what she shows instead).

## The frame list

Every state is optional except `idle` and `talk`. Missing states fall back gracefully; the "falls back to" column
says to what. Start with the **core** set, then add whatever you want more of.

### Core (draw these first)

| State | Frames | When it plays | Tips |
|---|---|---|---|
| `idle` | 1 + 1 `blink` | most of the time | `blink` = same image, eyes closed |
| `talk` | 3–4 | while her voice plays (random order) | **Only the mouth changes**: closed, small, mid, wide. Edit one base image so nothing else jitters |
| `think` | 2 | thinking before she answers | hand on chin, eyes up; frame 2 "thinking harder" |
| `hi` | 2–4 | happy / proud / teasing moods, greeting | waving, peace sign, big smile |
| `upset` | 2–4 | stern / angry / pouty fallback | arms crossed, facepalm, puffed cheeks |

### Living on the desktop (makes roaming look real)

| State | Frames | When it plays | Falls back to |
|---|---|---|---|
| `walk` | 4–8 | strolling along the taskbar | idle + a bouncing step |
| `held` | 2–3 | you're dragging her | surprised → upset (with a swing) |
| `fall` | 1–2 | dropping back to the taskbar | surprised → upset |
| `yawn` | 3–4 | the brain is still loading, after startup | sleep → think |
| `sleep` | 2 | idle while her energy is very low (late at night) | idle |
| `eat` | 3 | right after you press 🍙 | hi |
| `poked` | 1–2 | right after you press 👉 | surprised → upset |
| `surprised` | 1–2 | shared fallback for held / fall / poked | upset |

**Draw `walk` facing LEFT.** The app mirrors it when she walks right. Give `held` a "dangling" pose
(arms/legs loose, maybe a sweat drop): the app swings it.

### Moods (optional, more personality)

Name a state after a mood and it's used automatically when she's in that mood:
`happy`, `proud`, `teasing`, `stern`, `angry`, `pouty`, `worried`, `sleepy`. Otherwise `moods` in
`sprite.json` maps each mood to an existing state.

| Mood | Pose idea |
|---|---|
| `happy` | eyes closed smiling, sparkles |
| `proud` | hands on hips, chin up, "hmph!" smile |
| `teasing` | smirk, one eye half-closed, finger on lips |
| `stern` | arms crossed, flat mouth, pointing finger |
| `angry` | anger vein 💢, red face, fists |
| `pouty` | puffed cheeks, looking away |
| `worried` | eyebrows up, hands together |
| `sleepy` | half-closed eyes, drool, tilted head |

### Activity (optional)

| State | Frames | When |
|---|---|---|
| `read` | 2–4 | looking at files, calendar, her notes, your screen |
| `write` | 2–4 | writing a todo, a memory, a calendar entry |
| `tool` | 2–4 | everything else she does (PowerShell, system info…) |

Which tool uses which state is set in `tools` in `sprite.json`.

## Technical rules

1. **Transparent PNG**, every frame.
2. **One canvas size for every frame** (e.g. 256×256 or 512×512) and **the same baseline**: the bottom of her
   body sits at the same pixel row in every frame. Otherwise she jumps when the animation changes.
3. Leave a little empty space at the top for the mood badge.
4. Pixel art: keep `"pixelated": true` so it's scaled with sharp pixels. Painted / anime art: `"pixelated": false`.
5. `size` in `sprite.json` is the on-screen height in the chat window (220 is good). In roam mode she fills the
   small window.

## sprite.json

```json
{
  "name": "My Mai",
  "credit": "Art by me",
  "pixelated": false,
  "size": 220,
  "states": {
    "idle":  { "frames": ["idle/idle.png"], "blink": "idle/idle_blink.png" },
    "talk":  { "frames": ["talk/closed.png", "talk/small.png", "talk/mid.png", "talk/wide.png"], "fps": 8, "random": true },
    "think": { "frames": ["think/1.png", "think/2.png"], "fps": 1.5 },
    "hi":    { "frames": ["hi/1.png", "hi/2.png", "hi/3.png"], "fps": 5 },
    "upset": { "frames": ["upset/1.png", "upset/2.png"], "fps": 4 },
    "walk":  { "frames": ["walk/1.png", "walk/2.png", "walk/3.png", "walk/4.png"], "fps": 8 },
    "held":  { "frames": ["held/1.png", "held/2.png"], "fps": 3 },
    "yawn":  { "frames": ["yawn/1.png", "yawn/2.png", "yawn/3.png"], "fps": 2 },
    "eat":   { "frames": ["eat/1.png", "eat/2.png", "eat/3.png"], "fps": 4 },
    "pouty": { "frames": ["moods/pouty.png"] }
  },
  "moods": { "happy": "hi", "proud": "hi", "teasing": "hi", "stern": "upset", "angry": "upset", "worried": "think", "sleepy": "yawn" },
  "tools": { "list_folder": "think", "todo_add": "hi" }
}
```

`fps` = frames per second; `random: true` picks frames randomly (good for mouths).

## Generating the art with AI

What works best is a **consistent character** first, then poses:

1. **Reference sheet.** Generate one image of her: front view, full upper body, plain background. Write down
   a fixed description and reuse it word for word in every prompt, e.g. *"young woman, long pink hair,
   black over-ear headphones, black suit jacket, white shirt, black tie, warm brown eyes, confident smile"*.
2. **Poses from the reference.** Use a tool that accepts a reference image for character consistency (image
   editing models, `--cref`-style options, IP-Adapter / a character LoRA in Stable Diffusion). Prompt:
   `<description>, <pose>, same character as reference, centered, upper body, plain flat background`.
3. **Talk frames: don't generate four images.** Take the idle image and edit only the mouth (inpaint the mouth
   area, or draw it). Same for `blink` (eyes only).
4. **Background removal.** Use `rembg`, Photoshop, or remove.bg, then put every frame on the same transparent
   canvas, aligned to the same bottom line (Aseprite, Photopea, GIMP layers).
5. **Pixel art look (optional).** Downscale with nearest-neighbour to ~128 px tall, reduce the palette
   (Aseprite / LibreSprite), and keep `"pixelated": true`.
6. Run `node scripts/check-sprites.mjs <folder>`, pick the set in Settings → Look, and regenerate the README
   pictures with `MAI_SPRITE=<set> npx electron scripts/screenshots/capture.cjs` if you like.

Pose prompts for the list above:
- `walk`: "walking to the left, side view, mid-stride" (4 frames: contact, down, passing, up)
- `held`: "being lifted by the collar, legs dangling, surprised, sweat drop"
- `yawn`: "yawning with hand over mouth, eyes closed, tears in eyes"
- `eat`: "eating an onigiri happily, cheeks full"
- `poked`: "flinching, startled, one eye shut"
- `pouty`: "puffed cheeks, arms crossed, looking away"
- `teasing`: "smirking, one eyebrow raised, finger on lips"
- `sleep`: "dozing off, head tilted, eyes closed, zzz"

**Ask an AI assistant to check your set:** "run the sprite checker on my set and fix sprite.json". AGENTS.md
explains the format to it.
