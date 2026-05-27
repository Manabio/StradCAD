@echo off
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5173 " ^| findstr "LISTENING"') do (
    taskkill /PID %%p /F >nul 2>&1
)
cd /d "%~dp0app"
npm run dev
