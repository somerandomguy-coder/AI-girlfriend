# Sets up Mai's fully local voice: audio.cpp + VieNeu-TTS v3 Turbo + the Python phonemizer.
#   powershell -ExecutionPolicy Bypass -File scripts\setup-vieneu.ps1          # CPU build (~30 MB, keeps VRAM free)
#   powershell -ExecutionPolicy Bypass -File scripts\setup-vieneu.ps1 -Cuda    # CUDA 13.3 build (~850 MB, RTX 50xx ok)
param(
  [switch]$Cuda,
  # Also fetch VoxCPM2 (2.96 GB, needs a GPU): the expressive engine with per-mood style prompts.
  [switch]$Expressive,
  [string]$Version = "v0.9.3",
  [string[]]$Voices = @("truc_ly", "mai_anh", "thuy_dung", "ngoc_huyen", "ngoc_tran", "ngoc_linh", "doan_trang", "thuc_doan", "my_duyen", "quynh_anh", "kim_thanh", "minh_quan_pro")
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$ac = Join-Path $root "sidecars\audiocpp"
$model = Join-Path $ac "models\vieneu"
$dl = Join-Path $ac "dl"
New-Item -ItemType Directory -Force $dl, $model, (Join-Path $ac "bin") | Out-Null

function Get-File($url, $out) {
  if (Test-Path $out) { Write-Host "  have $(Split-Path -Leaf $out)"; return }
  Write-Host "  downloading $(Split-Path -Leaf $out)"
  Invoke-WebRequest -Uri $url -OutFile "$out.part"
  Move-Item "$out.part" $out
}

Write-Host "1/3 audio.cpp $Version ($(if ($Cuda) {'CUDA 13.3'} else {'CPU'}))"
$rel = "https://github.com/0xShug0/audio.cpp/releases/download/$Version"
$zips = if ($Cuda) { @("audio-$Version-bin-windows-x64-cuda13.3.zip", "audio-$Version-cudart-windows-x64-cuda13.3.zip") } else { @("audio-$Version-bin-windows-x64-cpu.zip") }
foreach ($z in $zips) {
  Get-File "$rel/$z" (Join-Path $dl $z)
  Expand-Archive -Force (Join-Path $dl $z) (Join-Path $ac "bin")
}

Write-Host "2/3 VieNeu-TTS v3 Turbo (q8_0) + voices"
$hf = "https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Turbo/resolve/main/gguf"
Get-File "$hf/vieneu-v3-turbo-q8_0.gguf" (Join-Path $model "vieneu-v3-turbo-q8_0.gguf")
Get-File "$hf/voices/manifest.json" (Join-Path $model "manifest.json")
foreach ($v in $Voices) {
  $vd = Join-Path $model "voices\$v"
  New-Item -ItemType Directory -Force $vd | Out-Null
  Get-File "$hf/voices/$v/ref_codes.txt" (Join-Path $vd "ref_codes.txt")
  Get-File "$hf/voices/$v/speaker.emb.txt" (Join-Path $vd "speaker.emb.txt")
}

if ($Expressive) {
  Write-Host "2b/3 VoxCPM2 (q8_0, 2.96 GB) for expressive voice"
  $vox = Join-Path $ac "modelsoxcpm2"
  New-Item -ItemType Directory -Force $vox | Out-Null
  Get-File "https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/VoxCPM2-GGUF/voxcpm2-q8_0.gguf" (Join-Path $vox "voxcpm2-q8_0.gguf")
}

Write-Host "3/3 Python sidecar (needle + sea-g2p phonemizer)"
$side = Join-Path $root "sidecars\needle"
$py = Join-Path $side ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { uv venv --python 3.12 (Join-Path $side ".venv") }
uv pip install --python $py --only-binary :all: sea-g2p==0.10.0 cactus-needle

Write-Host ""
Write-Host "Done. In Mai: Settings -> Voice -> Engine = vieneu$(if ($Cuda) {', VieNeu runs on = cuda'}), pick a voice, restart Mai."
