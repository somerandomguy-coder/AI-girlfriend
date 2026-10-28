@echo off
rem Starts Mai. Builds once if needed, then launches Electron detached so no console stays open.
cd /d "%~dp0"

rem Detect tools in user data or ProgramFiles if not yet refreshed in current CMD
if exist "%USERPROFILE%\.mai-companion\tools\node" set "PATH=%USERPROFILE%\.mai-companion\tools\node;%PATH%"
if exist "%ProgramFiles%\nodejs" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LocalAppData%\Programs\Ollama" set "PATH=%LocalAppData%\Programs\Ollama;%PATH%"

if not exist "node_modules\electron\dist\electron.exe" (
	where node >nul 2>nul
	if errorlevel 1 (
		echo.
		echo [Mai] Node.js is not installed yet.
		echo Please run setup.cmd first to install required tools.
		echo.
		pause
		exit /b 1
	)
	echo [Mai] Installing packages ^(first run^)...
	call npm install --no-fund --no-audit
)
if not exist "dist\app\main.js" (
	echo [Mai] Building app...
	call npm run build
)
if not exist "node_modules\electron\dist\electron.exe" (
	echo.
	echo [Mai] Error: Electron executable was not found.
	echo Please make sure Node.js is installed, then run setup.cmd.
	echo.
	pause
	exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
