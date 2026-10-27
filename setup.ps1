# Mai - one-shot, re-runnable Windows setup.
# Every step checks first and only does what's missing, so running it again is safe and fast.
#
#   Double-click setup.cmd, or:
#   powershell -ExecutionPolicy Bypass -File setup.ps1               # set everything up
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -CheckOnly    # just report what's missing
#   ... -Profile 32gb | 16gb | 8gb | cpu     force a model profile instead of detecting VRAM
#   ... -NoVoice      skip the local voice (she uses the online edge voice)
#   ... -Autostart    also start Mai when Windows starts
param(
	[switch]$CheckOnly,
	[ValidateSet("auto", "32gb", "16gb", "8gb", "cpu")][string]$Profile = "auto",
	[switch]$NoVoice,
	[switch]$Autostart
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = $PSScriptRoot
$DataDir = Join-Path $env:USERPROFILE ".mai-companion"
$script:Missing = 0

function Say($tag, $msg, $color = "Gray") { Write-Host ("  [{0,-5}] {1}" -f $tag, $msg) -ForegroundColor $color }
function Step($title) { Write-Host ""; Write-Host "== $title" -ForegroundColor Magenta }
function Ok($msg) { Say "ok" $msg "Green" }
function Todo($msg) { $script:Missing++; Say $(if ($CheckOnly) { "need" } else { "do" }) $msg "Yellow" }
function Fail($msg) { Say "fail" $msg "Red"; throw $msg }

function Refresh-Path {
	$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Winget-Install($id, $name) {
	if (-not (Has "winget")) { Fail "winget is missing. Install 'App Installer' from the Microsoft Store, then run setup again." }
	Say "..." "installing $name (winget $id)"
	winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements --scope user 2>$null | Out-Null
	if ($LASTEXITCODE -ne 0) { winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Null }
	Refresh-Path
}

function Need-Tool($cmd, $wingetId, $name, [scriptblock]$versionOk = { $true }) {
	if ((Has $cmd) -and (& $versionOk)) { Ok "$name"; return }
	Todo "$name"
	if (-not $CheckOnly) {
		Winget-Install $wingetId $name
		if (-not (Has $cmd)) { Fail "$name installed but '$cmd' is not on PATH yet. Close this window, open a new one, and run setup again." }
		Ok "$name installed"
	}
}

Write-Host ""
Write-Host "  Mai setup  $(if ($CheckOnly) { '(check only)' })" -ForegroundColor Magenta
Write-Host "  repo: $Root"

# ---------------------------------------------------------------- tools
Step "Tools"
Need-Tool "git" "Git.Git" "Git (her memory is versioned with git)"
Need-Tool "node" "OpenJS.NodeJS.LTS" "Node.js 22+" { [int]((node -v) -replace "^v(\d+).*", '$1') -ge 22 }
Need-Tool "ollama" "Ollama.Ollama" "Ollama (runs the AI models)"
Need-Tool "uv" "astral-sh.uv" "uv (Python for the helper sidecar)"

# ---------------------------------------------------------------- hardware -> model profile
Step "Hardware"
$vram = 0
$gpu = "none"
if (Has "nvidia-smi") {
	$line = (nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits | Select-Object -First 1)
	if ($line) { $gpu, $mem = $line.Split(",") | ForEach-Object { $_.Trim() }; $vram = [math]::Round([int]$mem / 1024) }
}
if ($Profile -eq "auto") {
	if ($vram -ge 24) { $Profile = "32gb" } elseif ($vram -ge 12) { $Profile = "16gb" } elseif ($vram -ge 7) { $Profile = "8gb" } else { $Profile = "cpu" }
}
Ok "GPU: $gpu, $vram GB VRAM -> profile '$Profile'"
$profiles = @{
	"32gb" = @{ main = @("gemma4:26b-a4b-it-qat", "gemma4:12b"); helper = "qwen3.5:4b"; ctx = 32768; voiceCuda = $true; expressive = $true }
	"16gb" = @{ main = @("gemma4:12b"); helper = "qwen3.5:4b"; ctx = 16384; voiceCuda = $false }
	"8gb"  = @{ main = @("qwen3.5:9b", "qwen3.5:4b"); helper = "qwen3.5:4b"; ctx = 12288; voiceCuda = $false }
	"cpu"  = @{ main = @("qwen3.5:4b"); helper = "qwen3.5:4b"; ctx = 8192; voiceCuda = $false }
}
$P = $profiles[$Profile]

# ---------------------------------------------------------------- Ollama models
Step "AI models (Ollama)"
function Ollama-Up { try { Invoke-RestMethod "http://127.0.0.1:11434/api/version" -TimeoutSec 2 | Out-Null; $true } catch { $false } }
if (-not $CheckOnly -and (Has "ollama") -and -not (Ollama-Up)) {
	Say "..." "starting Ollama"
	$app = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama app.exe"
	if (Test-Path $app) { Start-Process $app } else { Start-Process "ollama" "serve" -WindowStyle Hidden }
	for ($i = 0; $i -lt 30 -and -not (Ollama-Up); $i++) { Start-Sleep 1 }
}
$have = @()
if (Has "ollama") { $have = (ollama list 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_ -split "\s+")[0] }) }
function Pull-First($candidates) {
	foreach ($tag in $candidates) {
		if ($have -contains $tag -or $have -contains "${tag}:latest") { Ok "model $tag"; return $tag }
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
$mainTag = Pull-First $P.main
$helperTag = Pull-First @($P.helper)
# Wrap them with the context size Mai expects (cheap: no extra download).
foreach ($pair in @(@("mai-brain", $mainTag), @("mai-helper", $helperTag))) {
	$name, $from = $pair
	$want = "FROM $from`nPARAMETER num_ctx $($P.ctx)`n"
	$mf = Join-Path $Root "ollama\$name.Modelfile"
	$current = if (Test-Path $mf) { Get-Content $mf -Raw } else { "" }
	if (($have -contains "${name}:latest") -and ($current -eq $want)) { Ok "$name -> $from ($($P.ctx) ctx)"; continue }
	Todo "$name -> $from ($($P.ctx) ctx)"
	if (-not $CheckOnly) {
		Set-Content -Path $mf -Value $want -NoNewline -Encoding ascii
		ollama create $name -f $mf | Out-Null
		Ok "$name created"
	}
}

# ---------------------------------------------------------------- app
Step "App (Node + Electron)"
if (Test-Path (Join-Path $Root "node_modules\electron")) { Ok "npm packages" } else {
	Todo "npm packages"
	if (-not $CheckOnly) { Push-Location $Root; npm install --no-fund --no-audit; Pop-Location; Ok "npm packages installed" }
}
$dist = Join-Path $Root "dist\app\main.js"
$newestSrc = (Get-ChildItem (Join-Path $Root "src") -Recurse -Filter *.ts | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
if ((Test-Path $dist) -and ((Get-Item $dist).LastWriteTime -ge $newestSrc)) { Ok "build" } else {
	Todo "build"
	if (-not $CheckOnly) { Push-Location $Root; npm run build | Out-Null; Pop-Location; Ok "built" }
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
	$wantCuda = $P.voiceCuda
	$voxFile = Join-Path $Root "sidecarsaudiocppmodelsoxcpm2oxcpm2-q8_0.gguf"
	$wantVox = [bool]$P.expressive
	if ((Test-Path $gguf) -and (Test-Path $server) -and ((-not $wantCuda) -or (Test-Path $cudaDll)) -and ((-not $wantVox) -or (Test-Path $voxFile))) { Ok "VieNeu-TTS + audio.cpp ($(if ($wantCuda) {'CUDA'} else {'CPU'}))" } else {
		Todo "VieNeu-TTS + audio.cpp ($(if ($wantCuda) {'CUDA, ~850 MB'} else {'CPU, ~220 MB'}))$(if ($wantVox) {' + VoxCPM2 expressive voice (~3 GB)'})"
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
Set-Val $ol "model" "mai-brain"; Set-Val $ol "smallModel" "mai-helper"; Set-Val $ol "contextWindow" $P.ctx
$tts = Ensure-Obj $cfg "tts"
Set-Val $tts "engine" $voiceEngine
if ($voiceEngine -eq "vieneu") { $vn = Ensure-Obj $tts "vieneu"; Set-Val $vn "backend" $(if ($P.voiceCuda) { "cuda" } else { "cpu" }) }
if ($CheckOnly) { Ok "would write $cfgFile (model mai-brain, voice $voiceEngine)" } else {
	# No BOM: Windows PowerShell 5.1 adds one with -Encoding utf8, and JSON parsers reject it.
	[IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
	Ok "saved $cfgFile"
}

# ---------------------------------------------------------------- shortcuts
Step "Shortcuts"
$launcher = Join-Path $Root "start-mai.cmd"
$lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Mai.lnk"
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
if (Test-Path $lnk) { Ok "desktop shortcut" } else {
	Todo "desktop shortcut 'Mai'"
	if (-not $CheckOnly) { Make-Shortcut $lnk; Ok "desktop shortcut created" }
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
