# One-liner installer for Mai. In PowerShell:
#   irm https://raw.githubusercontent.com/somerandomguy-coder/AI-girlfriend/main/bootstrap.ps1 | iex
# Installs git if needed, downloads (or updates) Mai into %USERPROFILE%\Mai, then runs setup.ps1.
$ErrorActionPreference = "Stop"
$Repo = "https://github.com/somerandomguy-coder/AI-girlfriend.git"
$Dir = Join-Path $env:USERPROFILE "Mai"
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
	Write-Host "Installing git..." -ForegroundColor Magenta
	winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
	Refresh-Path
}
if (Test-Path (Join-Path $Dir ".git")) {
	Write-Host "Updating Mai in $Dir" -ForegroundColor Magenta
	git -C $Dir pull --ff-only
} else {
	Write-Host "Downloading Mai into $Dir" -ForegroundColor Magenta
	git clone --depth 1 $Repo $Dir
}
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dir "setup.ps1") @args
