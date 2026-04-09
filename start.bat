@echo off
chcp 65001 > nul
echo Starting 國考知識王...

:: Kill any existing processes on these ports
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001 " 2^>nul') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5173 " 2^>nul') do taskkill /F /PID %%a >nul 2>&1

start "國考知識王 - Backend" cmd /k "cd /d %~dp0backend && node server.js"
timeout /t 2 /nobreak > nul
start "國考知識王 - Frontend" cmd /k "cd /d %~dp0frontend && npx vite --open"

echo.
echo Backend:  http://localhost:3001
echo Frontend: http://localhost:5173
echo.
echo 瀏覽器將自動開啟，請切換至手機模式 (F12 -> Ctrl+Shift+M)
timeout /t 3 /nobreak > nul
