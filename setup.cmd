@echo off
rem First-time setup: create the "Assignment Manager" Desktop shortcut, then open the app.
where node >nul 2>nul || (
  echo Node.js was not found. Install it from https://nodejs.org, then run setup.cmd again.
  pause
  exit /b 1
)
node "%~dp0tools\setup.js"
