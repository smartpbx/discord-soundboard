@echo off
title Soundboard Companion Setup
echo ============================================
echo   Soundboard Global Hotkey Companion Setup
echo ============================================
echo.

:: Check for Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Python is not installed or not in PATH.
    echo.
    echo     Download Python from: https://www.python.org/downloads/
    echo     IMPORTANT: Check "Add Python to PATH" during install!
    echo.
    pause
    exit /b 1
)

echo [+] Python found.

:: Install dependencies
echo [*] Installing required packages...
pip install keyboard requests >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Failed to install packages. Try running as Administrator.
    pause
    exit /b 1
)
echo [+] Packages installed.

:: Check for .env
if exist "%~dp0.env" (
    echo [+] Config file found (.env)
    echo.
    echo     Setup complete! Run "start.bat" to start the companion.
    echo.
    pause
    exit /b 0
)

:: Create .env interactively
echo.
echo [*] First-time setup — let's configure your connection.
echo.
set /p SURL="Soundboard URL (e.g. https://soundboard.example.com or http://192.168.1.200:3000): "
set /p STOKEN="Companion Token (same value as COMPANION_TOKEN in your LXC .env): "
echo.

(
echo # Soundboard Companion Config
echo SOUNDBOARD_URL=%SURL%
echo COMPANION_TOKEN=%STOKEN%
echo STOP_KEY=s
echo PAUSE_KEY=space
) > "%~dp0.env"

echo [+] Config saved to .env
echo.
echo     Setup complete! Run "start.bat" to start the companion.
echo.
pause
