# Mai - one-shot, re-runnable Windows setup.
# Every step checks first and only does what's missing, so running it again is safe and fast.
#
#   Double-click setup.cmd, or:
#   powershell -ExecutionPolicy Bypass -File setup.ps1               # set everything up
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -CheckOnly    # just report what's missing
#   ... -Profile 32gb | 16gb | 8gb | cpu     force a model profile instead of detecting VRAM
#   ... -Model <tag>  reuse an already downloaded Ollama model (e.g. -Model qwen3.5:4b)
#   ... -SkipModels   reuse whatever models are already in Ollama without downloading
#   ... -NoVoice      skip the local voice (she uses the online edge voice)
#   ... -Autostart    also start Mai when Windows starts
param(
	[switch]$CheckOnly,
	[ValidateSet("auto", "32gb", "16gb", "8gb", "cpu")][string]$Profile = "auto",
	[string]$Model = "",
	[switch]$SkipModels,
	[switch]$NoVoice,
	[switch]$Autostart
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = $PSScriptRoot
$UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
$DataDir = Join-Path $UserHome ".mai-companion"
$script:Missing = 0

function Say($tag, $msg, $color = "Gray") { Write-Host ("  [{0,-5}] {1}" -f $tag, $msg) -ForegroundColor $color }
function Step($title) { Write-Host ""; Write-Host "== $title" -ForegroundColor Magenta }
function Ok($msg) { Say "ok" $msg "Green" }
function Todo($msg) { $script:Missing++; Say $(if ($CheckOnly) { "need" } else { "do" }) $msg "Yellow" }
function Fail($msg) { Say "fail" $msg "Red"; throw $msg }

function Refresh-Path {
	$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
	$extraPaths = @()
	if ($env:ProgramFiles) {
		$extraPaths += (Join-Path $env:ProgramFiles "nodejs")
		$extraPaths += (Join-Path $env:ProgramFiles "Git\cmd")
	}
	if ($env:LOCALAPPDATA) {
		$extraPaths += (Join-Path $env:LOCALAPPDATA "Programs\Ollama")
		$extraPaths += (Join-Path $env:LOCALAPPDATA "Programs\nodejs")
		$extraPaths += (Join-Path $env:LOCALAPPDATA "Programs\Git\cmd")
	}
	if ($UserHome) {
		$extraPaths += (Join-Path $UserHome ".local\bin")
		$extraPaths += (Join-Path $UserHome ".cargo\bin")
		$extraPaths += (Join-Path $UserHome ".mai-companion\tools\node")
		$extraPaths += (Join-Path $UserHome ".mai-companion\tools\git\cmd")
	}
	foreach ($p in $extraPaths) {
		if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) {
			$env:Path = "$p;$env:Path"
		}
	}
}
Refresh-Path
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Winget-Install($id, $name) {
	if (-not (Has "winget")) { return $false }
	Say "..." "installing $name (winget $id)"
	winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements --scope user 2>$null | Out-Null
	if ($LASTEXITCODE -ne 0) { winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements 2>$null | Out-Null }
	Refresh-Path
	return $true
}

function Install-Node-Direct {
	Say "..." "downloading standalone Node.js 22 (no admin needed)..."
	$toolsDir = Join-Path $DataDir "tools"
	New-Item -ItemType Directory -Force $toolsDir | Out-Null
	$nodeDir = Join-Path $toolsDir "node"
	$zip = Join-Path $toolsDir "node.zip"
	$tmp = Join-Path $toolsDir "node_tmp"
	$url = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip"
	try {
		Invoke-WebRequest -Uri $url -OutFile $zip
		Expand-Archive -Path $zip -DestinationPath $tmp -Force
		$inner = (Get-ChildItem $tmp | Where-Object { $_.PSIsContainer } | Select-Object -First 1).FullName
		if (Test-Path $nodeDir) { Remove-Item -Path $nodeDir -Recurse -Force -ErrorAction SilentlyContinue }
		Move-Item -Path $inner -Destination $nodeDir -Force
		Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
		Remove-Item -Path $zip -Force -ErrorAction SilentlyContinue
		$env:Path = "$nodeDir;$env:Path"
		Refresh-Path
	} catch {
		Say "warn" "direct Node.js download failed: $_" "DarkYellow"
	}
}

function Install-Git-Direct {
	Say "..." "downloading standalone MinGit (no admin needed)..."
	$toolsDir = Join-Path $DataDir "tools"
	New-Item -ItemType Directory -Force $toolsDir | Out-Null
	$gitDir = Join-Path $toolsDir "git"
	$zip = Join-Path $toolsDir "git.zip"
	$url = "https://github.com/git-for-windows/git/releases/download/v2.48.1.windows.1/MinGit-2.48.1-64-bit.zip"
	try {
		Invoke-WebRequest -Uri $url -OutFile $zip
		New-Item -ItemType Directory -Force $gitDir | Out-Null
		Expand-Archive -Path $zip -DestinationPath $gitDir -Force
		Remove-Item -Path $zip -Force -ErrorAction SilentlyContinue
		$cmdPath = Join-Path $gitDir "cmd"
		$env:Path = "$cmdPath;$env:Path"
		Refresh-Path
	} catch {
		Say "warn" "direct Git download failed: $_" "DarkYellow"
	}
}

function Install-Uv-Direct {
	Say "..." "installing uv..."
	try {
		Invoke-RestMethod "https://astral.sh/uv/install.ps1" | Invoke-Expression
	} catch {}
	Refresh-Path
}

function Install-Ollama-Direct {
	Say "..." "downloading Ollama installer..."
	$installer = Join-Path $env:TEMP "OllamaSetup.exe"
	try {
		Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $installer
		Say "..." "launching Ollama installer..."
		Start-Process $installer -Wait
		Refresh-Path
	} catch {
		Say "warn" "Ollama installer download failed: $_" "DarkYellow"
	}
}

function Need-Tool($cmd, $wingetId, $name, [scriptblock]$versionOk = { $true }, [scriptblock]$fallback = $null) {
	if ((Has $cmd) -and (& $versionOk)) { Ok "$name"; return }
	Todo "$name"
	if (-not $CheckOnly) {
		Winget-Install $wingetId $name | Out-Null
		if (-not ((Has $cmd) -and (& $versionOk)) -and $fallback) {
			& $fallback
		}
		if (-not ((Has $cmd) -and (& $versionOk))) {
			Fail "$name could not be found or installed automatically. Please install $name manually and run setup again."
		}
		Ok "$name installed"
	}
}

Write-Host ""
Write-Host "  Mai setup  $(if ($CheckOnly) { '(check only)' })" -ForegroundColor Magenta
Write-Host "  repo: $Root"

# ---------------------------------------------------------------- tools
Step "Tools"
Need-Tool "git" "Git.Git" "Git (her memory is versioned with git)" { $true } { Install-Git-Direct }
Need-Tool "node" "OpenJS.NodeJS.LTS" "Node.js 22+" { [int]((node -v) -replace "^v(\d+).*", '$1') -ge 22 } { Install-Node-Direct }
# 0.40.4+: her goal-check judge is an Ollama "decision" model (POST /v1/systemone), which older versions can't pull.
function Ollama-Version {
	$v = (ollama --version 2>&1 | Out-String)
	if ($v -match '(\d+)\.(\d+)\.(\d+)') { [version]"$($matches[1]).$($matches[2]).$($matches[3])" } else { [version]"0.0.0" }
}
Need-Tool "ollama" "Ollama.Ollama" "Ollama 0.40.4+ (runs the AI models)" { (Ollama-Version) -ge [version]"0.40.4" } { Install-Ollama-Direct }
Need-Tool "uv" "astral-sh.uv" "uv (Python for the helper sidecar)" { $true } { Install-Uv-Direct }

# ---------------------------------------------------------------- hardware -> model profile
Step "Hardware"
$vram = 0
$gpu = "none"
$isNvidia = $false

if (Has "nvidia-smi") {
	try {
		$line = (nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
		if ($line) {
			$gpu, $mem = $line.Split(",") | ForEach-Object { $_.Trim() }
			$vram = [math]::Round([int]$mem / 1024)
			$isNvidia = $true
		}
	} catch {}
}

if ($gpu -eq "none" -or $vram -eq 0) {
	try {
		$regPath = "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\*"
		$adapters = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue | Where-Object {
			$_.DriverDesc -and $_.DriverDesc -notmatch "Basic Render|Virtual|Remote|RDP"
		}
		$best = $null
		$maxMem = [int64]0
		foreach ($a in $adapters) {
			$bytes = [int64]0
			if ($a."HardwareInformation.qwMemorySize") {
				$bytes = [int64]$a."HardwareInformation.qwMemorySize"
			} elseif ($a."HardwareInformation.MemorySize") {
				$bytes = [int64]$a."HardwareInformation.MemorySize"
			}
			if ($bytes -gt $maxMem) {
				$maxMem = $bytes
				$best = $a
			}
		}
		if ($best) {
			$gpu = if ($best.DriverDesc) { $best.DriverDesc } else { $best."HardwareInformation.AdapterString" }
			$vram = [math]::Round($maxMem / 1GB)
			if ($gpu -match "NVIDIA") { $isNvidia = $true }
		}
	} catch {}
}

if ($gpu -eq "none" -or $vram -eq 0) {
	try {
		$vc = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
			Where-Object { $_.Name -notmatch "Basic|Virtual|Remote" } |
			Sort-Object AdapterRAM -Descending | Select-Object -First 1
		if ($vc) {
			$gpu = $vc.Name
			$vram = [math]::Max(1, [math]::Round($vc.AdapterRAM / 1GB))
			if ($gpu -match "NVIDIA") { $isNvidia = $true }
		}
	} catch {}
}

if ($Profile -eq "auto") {
	if ($vram -ge 24) { $Profile = "32gb" } elseif ($vram -ge 12) { $Profile = "16gb" } elseif ($vram -ge 7) { $Profile = "8gb" } else { $Profile = "cpu" }
}
Ok "GPU: $gpu, $vram GB VRAM -> profile '$Profile'"
$profiles = @{
	# 24 GB+: same brain as 16 GB (gemma4:12b is plenty for a companion); the extra VRAM goes to a longer
	# context for work mode and to the GPU voice (VieNeu on CUDA + VoxCPM2).
	# judge: the goal-check decision model (3.9 GB VRAM, ~80 ms per check; scripts/bench/judge-bench.ts).
	# Smaller cards have no room for it: empty means her own model judges, slower, on fewer replies.
	"32gb" = @{ main = @("gemma4:12b"); judge = "tev1:4b-q4_K_M"; ctx = 32768; voiceCuda = $true; expressive = $true }
	"16gb" = @{ main = @("gemma4:12b"); judge = "tev1:4b-q4_K_M"; ctx = 16384; voiceCuda = $false }
	"8gb"  = @{ main = @("qwen3.5:9b", "qwen3.5:4b"); judge = ""; ctx = 12288; voiceCuda = $false }
	"cpu"  = @{ main = @("qwen3.5:4b"); judge = ""; ctx = 8192; voiceCuda = $false }
}
$P = $profiles[$Profile]

# ---------------------------------------------------------------- app
Step "App (Node + Electron)"
# Reinstall when an update changed the dependencies (package-lock.json newer than the installed tree),
# so "git pull" + setup always ends up with the right packages.
$lockFile = Join-Path $Root "package-lock.json"
$installedLock = Join-Path $Root "node_modules\.package-lock.json"
$depsCurrent = (Test-Path (Join-Path $Root "node_modules\electron")) -and (Test-Path $installedLock) -and ((Get-Item $installedLock).LastWriteTime -ge (Get-Item $lockFile).LastWriteTime)
if ($depsCurrent) { Ok "npm packages" } else {
	Todo "npm packages (install / update)"
	if (-not $CheckOnly) { Push-Location $Root; npm install --no-fund --no-audit; Pop-Location; Ok "npm packages installed" }
}
$dist = Join-Path $Root "dist\app\main.js"
$newestSrc = (Get-ChildItem (Join-Path $Root "src") -Recurse -Filter *.ts | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
if ((Test-Path $dist) -and ((Get-Item $dist).LastWriteTime -ge $newestSrc)) { Ok "build" } else {
	Todo "build"
	if (-not $CheckOnly) { Push-Location $Root; npm run build | Out-Null; Pop-Location; Ok "built" }
}

# ---------------------------------------------------------------- Ollama RAM limits
# Ollama's runner (llama-server) keeps old conversations in system RAM: a prompt cache of up to 8 GB plus
# up to 32 "context checkpoints" per chat: 10-15 GB of RAM even though the model itself sits in VRAM.
# Mai has one conversation, so she only needs enough cache to get it back after a side call (goal check,
# screen look) used the model: 2 GB does that (next turn 1.5 s instead of 3.4 s; RAM ~3 GB instead of ~10).
# Measured with scripts/bench/cache-bench.mjs. Read by every model Ollama starts, so Ollama is restarted
# once if they change.
Step "Ollama memory limits"
function Ollama-Up { try { Invoke-RestMethod "http://127.0.0.1:11434/api/version" -TimeoutSec 2 | Out-Null; $true } catch { $false } }
$ramLimits = @{ "LLAMA_ARG_CACHE_RAM" = "2048"; "LLAMA_ARG_CTX_CHECKPOINTS" = "4" }
$changed = $false
foreach ($k in $ramLimits.Keys) {
	if ([Environment]::GetEnvironmentVariable($k, "User") -eq $ramLimits[$k]) { Ok "$k = $($ramLimits[$k])"; continue }
	Todo "$k = $($ramLimits[$k]) (caps Ollama's RAM cache)"
	if (-not $CheckOnly) {
		[Environment]::SetEnvironmentVariable($k, $ramLimits[$k], "User")
		Set-Item -Path "Env:$k" -Value $ramLimits[$k]
		$changed = $true
	}
}
if ($changed -and (Ollama-Up)) {
	Say "..." "restarting Ollama so the limits apply"
	Get-Process "ollama app", "ollama", "llama-server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
	Start-Sleep 2
}

# ---------------------------------------------------------------- Ollama models
Step "AI models (Ollama)"
if (-not $CheckOnly -and (Has "ollama") -and -not (Ollama-Up)) {
	Say "..." "starting Ollama"
	$app = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama app.exe"
	if (Test-Path $app) { Start-Process $app } else { Start-Process "ollama" "serve" -WindowStyle Hidden }
	for ($i = 0; $i -lt 30 -and -not (Ollama-Up); $i++) { Start-Sleep 1 }
}
$have = @()
if (Has "ollama") { $have = (ollama list 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_ -split "\s+")[0] }) }
function Pull-First($candidates, [switch]$AllowDownload = $true) {
	foreach ($tag in $candidates) {
		if ($have -contains $tag -or $have -contains "${tag}:latest") { Ok "model $tag (reusing existing)"; return $tag }
	}
	if (-not $AllowDownload -or $SkipModels) {
		$nonHelper = $have | Where-Object { $_ -notlike "mai-*" } | Select-Object -First 1
		if ($nonHelper) {
			Ok "reusing existing model: $nonHelper"
			return $nonHelper
		}
	}
	foreach ($tag in $candidates) {
		Todo "model $tag (download; this is the big one, a few GB)"
		if ($CheckOnly) { return $tag }
		ollama pull $tag
		if ($LASTEXITCODE -eq 0) { Ok "model $tag"; return $tag }
		Say "warn" "could not pull $tag, trying the next option" "DarkYellow"
	}
	Fail "none of these models could be downloaded: $($candidates -join ', ')"
}
$mainCandidates = if ($Model) { @($Model) } else { $P.main }
$mainTag = Pull-First $mainCandidates -AllowDownload:(-not $SkipModels)
$judgeTag = $P.judge
if ($judgeTag) {
	if ($have -contains $judgeTag) { Ok "goal-check model $judgeTag" }
	elseif ($SkipModels) { Say "warn" "goal-check model $judgeTag not downloaded (-SkipModels): her own model will judge" "DarkYellow"; $judgeTag = "" }
	else {
		Todo "goal-check model $judgeTag (download, ~3 GB)"
		if (-not $CheckOnly) {
			ollama pull $judgeTag
			if ($LASTEXITCODE -eq 0) { Ok "goal-check model $judgeTag" } else { Say "warn" "could not pull ${judgeTag}, her own model will judge" "DarkYellow"; $judgeTag = "" }
		}
	}
}
# Wrap the brain with the context size Mai expects (cheap: no extra download). The judge needs no wrapper.
foreach ($pair in @(,@("mai-brain", $mainTag))) {
	$name, $from = $pair
	$want = "FROM $from`nPARAMETER num_ctx $($P.ctx)`n"
	# The generated Modelfile is per machine, so it lives in the data folder, not the git repo (editing
	# tracked files here would make the next "git pull" refuse to update).
	$mf = Join-Path $DataDir "ollama\$name.Modelfile"
	$current = if (Test-Path $mf) { Get-Content $mf -Raw } else { "" }
	if (($have -contains "${name}:latest") -and ($current -eq $want)) { Ok "$name -> $from ($($P.ctx) ctx)"; continue }
	Todo "$name -> $from ($($P.ctx) ctx)"
	if (-not $CheckOnly) {
		New-Item -ItemType Directory -Force (Split-Path $mf) | Out-Null
		Set-Content -Path $mf -Value $want -NoNewline -Encoding ascii
		ollama create $name -f $mf | Out-Null
		Ok "$name created"
	}
}

# ---------------------------------------------------------------- python sidecar
Step "Helper sidecar (tool-call repair + Vietnamese phonemizer)"
$side = Join-Path $Root "sidecars\needle"
$py = Join-Path $side ".venv\Scripts\python.exe"
$sideOk = (Test-Path $py) -and ((& $py -I -c "import needle, sea_g2p; print('ok')" 2>$null) -eq "ok")
if ($sideOk) { Ok "python sidecar" } else {
	Todo "python sidecar (Python 3.12 venv + cactus-needle + sea-g2p)"
	if (-not $CheckOnly) {
		if (-not (Test-Path $py)) { uv venv --python 3.12 (Join-Path $side ".venv") | Out-Null }
		uv pip install --python $py --only-binary :all: sea-g2p==0.10.0 cactus-needle | Out-Null
		Ok "python sidecar installed"
	}
}

# ---------------------------------------------------------------- voice
Step "Voice"
$voiceEngine = "edge"
if ($NoVoice) { Say "skip" "local voice (-NoVoice): she'll use the online edge voice" } else {
	$gguf = Join-Path $Root "sidecars\audiocpp\models\vieneu\vieneu-v3-turbo-q8_0.gguf"
	$server = Join-Path $Root "sidecars\audiocpp\bin\audiocpp_server.exe"
	$cudaDll = Join-Path $Root "sidecars\audiocpp\bin\ggml-cuda.dll"
	$wantCuda = $P.voiceCuda -and $isNvidia
	$voxFile = Join-Path $Root "sidecars\audiocpp\models\voxcpm2\voxcpm2-q8_0.gguf"
	$asrFile = Join-Path $Root "sidecars\audiocpp\models\qwen3-asr\qwen3-asr-0.6b-q8_0.gguf"
	$wantVox = [bool]$P.expressive -and $isNvidia
	if ((Test-Path $gguf) -and (Test-Path $server) -and ((-not $wantCuda) -or (Test-Path $cudaDll)) -and ((-not $wantVox) -or (Test-Path $voxFile)) -and (Test-Path $asrFile)) { Ok "VieNeu-TTS + Qwen3-ASR (mic) + audio.cpp ($(if ($wantCuda) {'CUDA'} else {'CPU'}))" } else {
		Todo "VieNeu-TTS + Qwen3-ASR mic (~1.2 GB) + audio.cpp ($(if ($wantCuda) {'CUDA, ~850 MB'} else {'CPU, ~220 MB'}))$(if ($wantVox) {' + VoxCPM2 expressive voice (~3 GB)'})"
		if (-not $CheckOnly) {
			$vargs = @("-ExecutionPolicy", "Bypass", "-File", (Join-Path $Root "scripts\setup-vieneu.ps1"))
			if ($wantCuda) { $vargs += "-Cuda" }
			if ($wantVox) { $vargs += "-Expressive" }
			& powershell @vargs
			Ok "voice installed"
		}
	}
	$voiceEngine = $(if ($wantVox) { "voxcpm2" } else { "vieneu" })
}

# ---------------------------------------------------------------- config
Step "Mai's settings"
New-Item -ItemType Directory -Force $DataDir | Out-Null
$cfgFile = Join-Path $DataDir "config.json"
$cfg = if (Test-Path $cfgFile) { Get-Content $cfgFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
function Ensure-Obj($o, $name) { if (-not ($o.PSObject.Properties.Name -contains $name)) { $o | Add-Member -NotePropertyName $name -NotePropertyValue ([pscustomobject]@{}) }; $o.$name }
function Set-Val($o, $name, $value) { if ($o.PSObject.Properties.Name -contains $name) { $o.$name = $value } else { $o | Add-Member -NotePropertyName $name -NotePropertyValue $value } }
$ol = Ensure-Obj $cfg "ollama"
Set-Val $ol "model" "mai-brain"; Set-Val $ol "judgeModel" $judgeTag; Set-Val $ol "contextWindow" $P.ctx
# Older setups had a "mai-helper" model for this; it's no longer used.
if ($ol.PSObject.Properties.Name -contains "smallModel") { $ol.PSObject.Properties.Remove("smallModel") }
$tts = Ensure-Obj $cfg "tts"
Set-Val $tts "engine" $voiceEngine
if ($voiceEngine -eq "vieneu") { $vn = Ensure-Obj $tts "vieneu"; Set-Val $vn "backend" $(if ($wantCuda) { "cuda" } else { "cpu" }) }
if ($CheckOnly) { Ok "would write $cfgFile (model mai-brain, voice $voiceEngine)" } else {
	# No BOM: Windows PowerShell 5.1 adds one with -Encoding utf8, and JSON parsers reject it.
	[IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
	Ok "saved $cfgFile"
}

# ---------------------------------------------------------------- shortcuts
Step "Shortcuts"
$launcher = Join-Path $Root "start-mai.cmd"
$desktop = [Environment]::GetFolderPath("Desktop")
if (-not $desktop -and $UserHome) { $desktop = Join-Path $UserHome "Desktop" }
$lnk = if ($desktop) { Join-Path $desktop "Mai.lnk" } else { "" }
function Make-Shortcut($path) {
	$sh = New-Object -ComObject WScript.Shell
	$s = $sh.CreateShortcut($path)
	$s.TargetPath = $launcher
	$s.WorkingDirectory = $Root
	$s.WindowStyle = 7
	$s.IconLocation = (Join-Path $Root "assets\mai.ico")
	$s.Description = "Mai, your desktop companion"
	$s.Save()
}
if ($lnk -and (Test-Path $lnk)) { Ok "desktop shortcut" } else {
	Todo "desktop shortcut 'Mai'"
	if (-not $CheckOnly -and $lnk) { Make-Shortcut $lnk; Ok "desktop shortcut created" }
}
if ($Autostart) {
	$startup = Join-Path ([Environment]::GetFolderPath("Startup")) "Mai.lnk"
	if (Test-Path $startup) { Ok "starts with Windows" } else {
		Todo "start with Windows"
		if (-not $CheckOnly) { Make-Shortcut $startup; Ok "added to Startup" }
	}
}

Write-Host ""
if ($CheckOnly) {
	if ($script:Missing -eq 0) { Write-Host "  Everything is set up. Start Mai from the desktop shortcut." -ForegroundColor Green }
	else { Write-Host "  $($script:Missing) thing(s) to do. Run setup without -CheckOnly." -ForegroundColor Yellow }
} else {
	Write-Host "  Done! Double-click 'Mai' on your desktop (or run start-mai.cmd)." -ForegroundColor Green
}
