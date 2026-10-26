@echo off
rem Starts the salon WhatsApp assistant and restarts it if it ever stops. Put a shortcut to this file in
rem the Startup folder (Win+R, type shell:startup) so it starts with the computer.
cd /d "%~dp0"
:loop
node index.js
echo Assistant stopped, restarting in 10 seconds...
timeout /t 10 /nobreak >nul
goto loop
