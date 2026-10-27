@echo off
rem Starts Mai. Builds once if needed, then launches Electron detached so no console stays open.
cd /d "%~dp0"
if not exist dist\app\main.js call npm run build
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
