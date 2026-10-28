# Benchmarks

Measured on the dev PC (RTX 5060 Ti 16 GB, Ollama 0.40.12) on 2026-10-29. Re-run them after changing the judge,
the prompt layout or Ollama's cache settings.

## Goal-check judge

After a reply, a judge decides whether to nudge her: **CONTINUE** (she promised or started work and stopped)
or **FABRICATED** (she stated live facts or claimed an action without the tool), versus **DONE** / **BLOCKED**
(leave her alone). A wrong nudge makes her repeat herself; a missed one lets her stop halfway or make things up.

```powershell
npx tsx scripts/bench/judge-bench.ts rules mai-brain so/tev1:4b-q4_K_M      # $env:GATE = "narrow" | "wide" | "all"
```

The test set is `scripts/bench/judge-cases.json`: 40 labeled Mai turns in Vietnamese and English. "Right in
Mai" counts what she actually does, including which replies reach the judge (`judgeGate` in
`src/core/judge.ts`).

| Judge | Kind | Replies checked | Right in Mai | Wrong nudges | Missed | Per check | VRAM |
|---|---|---|---|---|---|---|---|
| **`tev1:4b-q4_K_M`** (Together AI) | decision model | all | **98%** | **0** | 1 | **78 ms** | 3.9 GB |
| `nimble` (Bespoke Labs, 9B) | decision model | all | 98% | 0 | 1 | 141 ms | 9.7 GB |
| `mai-brain` (gemma4:12b) judging itself | chat | all | 100% | 0 | 0 | 860 ms | shared* |
| `mai-brain` judging itself | chat | wide | 98% | 0 | 1 | 860 ms | shared* |
| `d1:3b` (Liquid AI, multilingual) | decision model | all | 93% | 0 | 3 | 45 ms | 3.3 GB |
| no model, regex gate only | none | n/a | 90% | 0 | 4 | 0 | 0 |
| `kev:4b-q4_K_M` | decision model | all | 88% | 0 | 5 | 98 ms | 6.6 GB |
| `qwen3.5:2b` | chat | wide | 88% | 4 | 1 | 316 ms | 2.4 GB |
| `mai-helper` (qwen3.5:4b), the old judge | chat | narrow | 80–85% | 0 | 6–8 | 446 ms | 3.6 GB |
| `tev1:0.8b` | decision model | wide / all | 85% / 78% | 0 / 4 | 6 / 5 | 31 ms | 1.3 GB |
| `granite4:1b` | chat | wide | 80% | 0 | 8 | 381 ms | 3.6 GB |
| `d1-omni:600m` / `laya` | decision model | wide | 80% / 55% | 1 / 0 | 7 / 18 | 30 ms | 2.8 / 0.8 GB |
| needle (sidecar) | tool-call model | wide | 68% | 4 | 9 | 215 ms | CPU |

\* Judging with her own model costs no extra VRAM, but each check pushes her chat out of Ollama's single slot.
She then needs the prompt cache (below) to get it back.

**What Mai uses:**
- **16 GB+ cards:** `tev1:4b-q4_K_M`, checking every reply.
- **Smaller cards** (`judgeModel` empty), or if the decision model fails: her own model judges, and only replies
  the regex flags (claims, promises) or that used tools.
- The old `mai-helper` was worse than no judge at all: it called unfinished work "FABRICATED", which Mai
  ignores when tools were used.

Decision models are a newer Ollama capability ("Decision" filter on ollama.com/search). They generate no text:
`POST /v1/systemone` scores the options you give in one pass and returns probabilities. That's why they're fast
enough to check every reply. They need Ollama 0.40.4+. `strands-decider` needs Apple's MLX runtime and doesn't
run on Windows.

## Ollama prompt cache and prompt layout

`node scripts/bench/cache-bench.mjs mai-brain <inline|tail|append> [setting]` replays a 12-turn Mai-like chat
on a private Ollama server for each cache setting. Every 3rd turn includes a side call on the same model (a
judge or vision call), which evicts the chat.

| Prompt layout | Cache setting | Normal turn | Turn right after a side call | Runner RAM |
|---|---|---|---|---|
| "Right now" inside the system prompt (old) | default (8 GB, 32 checkpoints) | 2.5 s | 2.5 s | 8.2 GB |
| "Right now" on the newest message (current) | default | 1.39 s | 1.50 s | 9.6 GB |
| current | **2 GB, 4 checkpoints** (setup's setting) | **1.38 s** | **1.51 s** | **2.9 GB** |
| current | 1 GB, 4 checkpoints | 1.92 s | 3.42 s | 1.5 GB |
| current | no cache, no checkpoints | 1.75 s | 3.26 s | 1.4 GB |

- **Why a cache at all, with one conversation:** Ollama keeps one chat per model "slot". Any other call on the
  same model replaces it (vision, or the fallback judge). The cache is what brings her chat back without
  re-reading the whole conversation.
- **Why 2 GB:** 1 GB is too small to hold her chat, so it doesn't come back. 2 GB is enough, and the default
  8 GB only costs RAM.
- **Why the layout matters:** the changing time and mood block used to sit in the system prompt, before the
  history, so every turn re-read everything. It's now attached to his newest message (`buildNowNote` /
  `withNowNote` in `src/core/prompt.ts`), and turns got about 2× faster.
