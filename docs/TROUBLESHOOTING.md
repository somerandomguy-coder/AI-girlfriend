# Troubleshooting

**First step for anything:** run `setup.cmd -CheckOnly`. It lists what's missing or broken without changing
anything. Run `setup.cmd` to fix it.

### I can't find her
- She roams along the bottom of the screen. Click her to open the chat.
- `Ctrl+Alt+M` brings her up from anywhere (`Ctrl+Alt+Shift+M` if another app owns the first shortcut).
- The tray icon (click **^** next to the clock) → *Show / hide Mai*.
- Starting Mai again (desktop shortcut) while she's running just brings her back.

### She says "Ollama is not reachable"
Start Ollama (Start menu → Ollama), wait a few seconds, then restart Mai. `ollama list` in a terminal should
show `mai-brain` and `mai-helper`. If they're missing, run `setup.cmd`.

### Replies are slow
- Right after start she yawns while the models load; the first reply after that should take a few seconds.
- Check the GPU: `nvidia-smi` should show her model in VRAM. `ollama ps` should show `100% GPU`; if it says
  CPU, the model is too big for your card. Run setup with a smaller `-Profile`.
- Leave *Thinking* off in Settings → Brain.

### Her voice is the "online" one, or she's silent
- A notice like *"Local voice unavailable…"* means she fell back to the online voice. Check
  `%USERPROFILE%\.mai-companion\state\audiocpp-server.log`, then run `setup.cmd`.
- 🔊 might be muted (🔇).
- Test the voice on its own while Mai is running: `npx tsx scripts/tts-test.ts` writes WAVs into
  `.mai-companion\state\tts-test`.
- VoxCPM2 needs the CUDA build. Re-run setup, or `scripts\setup-vieneu.ps1 -Cuda -Expressive`.

### Windows asks about `audiocpp_server.exe` or `python.exe`
They're her local voice server and helper, listening on 127.0.0.1 only. Allow them.

### She did something I didn't want
- **Personality or memory:** ⚙ → History & rollback → pick the version before it → *Restore*.
- **Files:** she can only move files after you click *Allow*. Moves are listed in the chat history.
- **Turn things off:** Settings → Hands (PowerShell, quests, folders) and Settings → Eyes (screen).

### Setup fails
- **"winget is missing":** install *App Installer* from the Microsoft Store.
- **"not on PATH yet":** close the window, open a new one, run setup again (installers update PATH for new
  windows only).
- **A model download fails:** run setup again; finished downloads are kept.

### Start over
Quit Mai (tray → Quit) and rename `%USERPROFILE%\.mai-companion`. Next start she's brand new. Your old self is
still in the renamed folder.

### llama-server uses 10–15 GB of RAM (not VRAM)

That is Ollama's runner caching old conversations in system RAM: a prompt cache of up to 8 GB plus up to
32 "context checkpoints" per chat. The model itself is still in VRAM. `setup.cmd` caps it with two user
environment variables (`LLAMA_ARG_CACHE_RAM=1024`, `LLAMA_ARG_CTX_CHECKPOINTS=4`) and restarts Ollama. In
tests, RAM stayed around 2 GB with no speed difference. To undo it, delete those two variables and restart Ollama.
