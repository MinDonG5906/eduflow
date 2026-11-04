@echo off
cd /d "%~dp0app"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 from https://nodejs.org/ and run again.
  pause
  exit /b 1
)
node demo/start-demo.mjs
pause
