@echo off
title Soundboard Companion

:: Check for Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Python not found. Run setup.bat first!
    pause
    exit /b 1
)

:: Run the companion GUI
python "%~dp0hotkeys.py"
