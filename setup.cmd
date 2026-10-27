@echo off
rem Double-click me: installs and sets up everything Mai needs (safe to run again any time).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
echo.
pause
