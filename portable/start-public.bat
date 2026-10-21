@echo off
setlocal
title AdamenkoGeoMemories - Public read-only gallery
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-public.ps1"
set "launcher_exit_code=%errorlevel%"
if not "%launcher_exit_code%"=="0" pause
exit /b %launcher_exit_code%
