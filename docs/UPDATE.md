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

## If something goes wrong

- `.\setup.cmd -CheckOnly` lists what's missing without changing anything.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) covers the common problems.
- Your settings, memories and chat live in `%USERPROFILE%\.mai-companion`. Updates never touch them.
