# AGENTS.md: guide for AI coding assistants

You're helping someone customize or fix **Mai**, a local desktop AI companion for Windows: an Electron pet window
with a pi-SDK agent brain on Ollama and a local TTS voice. They may not be a programmer. Prefer small, verified
changes, and explain what you changed in plain words.

## Where things are

- **User data (not in this repo):** `%USERPROFILE%\.mai-companion\` (or `$env:MAI_HOME`).
  - `persona\*.md`: her personality and memory, a git repo.
  - `config.json`: settings.
  - `sprites\<set>\`: custom sprite sets.
  - `state\`: calendar, todos, needs, logs.
- **Defaults shipped with the app:**
  - `persona-template\`: the starting persona, copied on first run.
  - `sprites\aza\`: the default sprite set.
  - `src\core\config.ts`: `DEFAULT_CONFIG`.
- **Code map:** see `docs/ARCHITECTURE.md`. `src/core` is the brain (no Electron), `src/app` the desktop app,
  `src/app/renderer` plain HTML/CSS/JS (no build step).

## Common requests → what to do

| They say | Do |
|---|---|
| "Change her personality / make her X" | Edit **their** `%USERPROFILE%\.mai-companion\persona\SOUL.md` (the live one), above the `<!-- LOCKED` line. Commit in that folder: `git -C "$env:USERPROFILE\.mai-companion\persona" commit -am "[user] <why>"` so it shows in History. Only edit `persona-template/` if they want new installs to change. |
| "Check my sprites" / "add my sprite set" | Run `node scripts/check-sprites.mjs <folder>`, fix what it reports (usually `sprite.json` paths, canvas sizes, transparency). Format and frame list: `docs/SPRITES.md`. Then set `"spriteSet": "<folder name>"` in their config.json, or tell them Settings → Look. |
| "Her voice is wrong / change voice" | `docs/CUSTOMIZE.md#voice`. Voice ids are folders in `sidecars/audiocpp/models/vieneu/voices`. Engine + voice live in config.json `tts`. |
| "Use model X" | Check it fits: `recommendModels` in `src/core/system.ts` / `catalog/models.json`. `ollama pull X`, then update `ollama/mai-brain.Modelfile` + `ollama create mai-brain -f ollama/mai-brain.Modelfile`. |
| "She's broken / slow / silent" | Start with `powershell -ExecutionPolicy Bypass -File setup.ps1 -CheckOnly`, then `docs/TROUBLESHOOTING.md`. Logs: `state\audiocpp-server.log`. |
| "Add a feature / tool" | `docs/ARCHITECTURE.md` → "Where to change things". Add a test next to the existing ones. |

## Rules

- **Never weaken the safety rails** unless the user explicitly asks and understands the consequences:
  - the `<!-- LOCKED` section of SOUL.md;
  - the approval dialogs for file moves and PowerShell (`Services.approve` in `src/core/tools.ts`);
  - the blocklist in `src/core/shell.ts`;
  - `allowedRoots`.
- **Don't put personal data in the repo.** Their persona, memories, chat log and config stay in the data folder.
- **Keep both front ends working:** `src/core` must not import Electron.
- **Windows PowerShell 5.1 runs `setup.ps1`:**
  - keep it ASCII (no `→` / `—`);
  - no `?:` or `??`;
  - write `"${name}:latest"`, not `"$name:latest"`;
  - write JSON without a BOM.

## Verify before you say it's done

```powershell
npx tsc --noEmit -p .
npx tsx scripts/repair-test.ts; npx tsx scripts/shell-test.ts; npx tsx scripts/markdown-test.ts; npx tsx scripts/needs-test.ts; npx tsx scripts/files-test.ts
node scripts/check-sprites.mjs <sprite folder>          # after sprite changes
node --check src/app/renderer/pet.js                    # after renderer JS changes
$env:MAI_HOME="$env:TEMP\mai-e2e"; npx tsx scripts/e2e.ts   # after brain/prompt/tool changes (needs Ollama running)
```

Visual changes can be checked without a screen session: `npx electron scripts/screenshots/capture.cjs` renders
the real pet and settings pages into `docs/images/`.
