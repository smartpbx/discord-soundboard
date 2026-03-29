@echo off
title Soundboard Companion
echo ============================================
echo   Soundboard Global Hotkey Companion
echo ============================================
echo.

:: Check for .env
if not exist "%~dp0.env" (
    echo [!] No config found. Run setup.bat first!
    pause
    exit /b 1
)

:: Check for Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Python not found. Run setup.bat first!
    pause
    exit /b 1
)

:: Run the companion (may need admin for global hotkeys)
echo Starting companion... Press Ctrl+C to quit.
echo.
python "%~dp0hotkeys.py"
pause
