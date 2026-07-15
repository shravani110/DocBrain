@echo off
rem Launches DocBrain (no Electron needed).
rem Starts the local engine and opens the app in your default browser.
cd /d "%~dp0"

rem Already running? Just open the browser.
powershell -NoProfile -Command "try { Invoke-RestMethod http://127.0.0.1:8756/api/status -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
    start "" http://127.0.0.1:8756
    exit /b
)

start "DocBrain engine" /min cmd /c "cd backend && python main.py --port 8756"

rem Wait until the engine answers, then open the app.
powershell -NoProfile -Command "for ($i=0; $i -lt 60; $i++) { try { Invoke-RestMethod http://127.0.0.1:8756/api/status -TimeoutSec 2 | Out-Null; exit 0 } catch { Start-Sleep 1 } }; exit 1" >nul 2>&1
start "" http://127.0.0.1:8756
