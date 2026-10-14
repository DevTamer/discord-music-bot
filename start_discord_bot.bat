@echo off
cd /d "%~dp0"
title Music Bot

:loop
echo [%date% %time%] Starting bot...
node bot.js
echo.
echo [%date% %time%] Bot exited with code %errorlevel%. Restarting in 10 seconds...
echo Press Ctrl+C twice to stop for good.
timeout /t 10 /nobreak >nul
goto loop
