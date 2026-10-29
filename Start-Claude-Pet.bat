@echo off
cd /d "%~dp0"
title Claude Pet
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo Something went wrong. Take a photo of this window and send it to the author.
pause
exit /b 1
