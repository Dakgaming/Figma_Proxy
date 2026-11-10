@echo off
setlocal
cd /d "%~dp0"
title Figma OpenAI Proxy

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist .env (
  if exist .env.example copy .env.example .env >nul
)

echo.
echo Starting proxy on http://localhost:8741
echo First login: a browser window will open - click "Allow access" on the Figma page.
echo.
npx tsx src\index.ts
echo.
echo Proxy exited.
pause
