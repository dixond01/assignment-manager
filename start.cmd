@echo off
rem Double-click to launch the Assignment Manager and open it in your browser.
cd /d "%~dp0"
start "" http://localhost:3456
node server.js
