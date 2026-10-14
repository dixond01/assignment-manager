@echo off
rem First-time setup: create the "Assignment Manager" Desktop shortcut, then open the app.
where node >nul 2>nul || (
  echo Node.js was not found. Install it from https://nodejs.org, then run setup.cmd again.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\update_shortcut.ps1" -Create
call "%~dp0start.cmd"
