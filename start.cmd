@echo off
rem Open the Assignment Manager (starts the server hidden if needed; it stops itself when the app is closed).
start "" "%WINDIR%\System32\conhost.exe" --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launch.ps1"
