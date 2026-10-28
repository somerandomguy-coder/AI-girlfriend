# Updating Mai

Every update is the same two commands: get the new code, then run setup. Setup is incremental: it only
installs, downloads, rebuilds or reconfigures what changed, and skips everything that's already done.
You never need `npm run build` yourself.

## Every time

1. Quit Mai: tray icon (next to the clock, maybe under **^**) → **Quit**.
2. Open PowerShell in the Mai folder. If you installed with the one-line installer, that's:

   ```powershell
   cd $env:USERPROFILE\Mai
   ```

3. Get the update and run setup:

   ```powershell
   git pull
   .\setup.cmd
   ```

4. Start Mai from the **Mai** desktop shortcut.

## One-time extra step: updating from a version before 2026-10-28

Older setups wrote their model files into the repo (`ollama\*.Modelfile`). If `git pull` refuses with
*"Your local changes … would be overwritten"*, throw those away first; setup recreates them in the data
folder:

```powershell
git checkout -- ollama
git pull
.\setup.cmd
```

The 2026-10-28 update also:
- downloads the speech-recognition model for the 🎙️ mic (~1.2 GB);
- switches 24 GB+ PCs to `gemma4:12b`;
- caps how much RAM Ollama uses for caching. This sets two Windows user variables and restarts Ollama once.

Once she works, the old big model can be deleted to free ~16 GB of disk:

```powershell
ollama rm gemma4:26b-a4b-it-qat
```

## The 2026-10-29 update

- **Ollama is upgraded** if it's older than 0.40.4. Setup opens Ollama's installer: click through it.
- **New goal-check model:** `tev1:4b-q4_K_M` is downloaded (~2.8 GB). It's faster and more accurate than
  the old helper ([BENCHMARKS.md](BENCHMARKS.md)).
- **Bigger RAM cache:** Ollama's cache goes from 1 GB to 2 GB. This restarts Ollama once.

The old helper models are no longer used. Once she works, delete them to free ~3.4 GB of disk. Skip the
second line on 8 GB / CPU PCs, where `qwen3.5:4b` may be her brain:

```powershell
ollama rm mai-helper
ollama rm qwen3.5:4b
```

## If something goes wrong

- `.\setup.cmd -CheckOnly` lists what's missing without changing anything.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) covers the common problems.
- Your settings, memories and chat live in `%USERPROFILE%\.mai-companion`. Updates never touch them.
