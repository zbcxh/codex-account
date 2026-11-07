@echo off
rem One-click start for the Codex quota panel server.
rem If the boot-start scheduled task is missing it registers it, then waits for the port.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\codex-quota-server.ps1" -Action start
if errorlevel 1 (
  echo.
  echo [FAILED] Read the log paths printed above.
)
endlocal
pause
