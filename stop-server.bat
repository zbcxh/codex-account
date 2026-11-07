@echo off
rem One-click stop for the Codex quota panel server.
rem Stops the scheduled task and any node still holding the port. The boot-start task itself is kept.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\codex-quota-server.ps1" -Action stop
if errorlevel 1 (
  echo.
  echo [FAILED] Run this from an elevated window if the task is managed by another account.
)
endlocal
pause
