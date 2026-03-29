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
echo.
echo     Setup complete! Run "start.bat" to launch the companion.
echo.
pause
