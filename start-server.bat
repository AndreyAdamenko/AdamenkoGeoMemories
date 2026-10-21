@echo off
setlocal
title AdamenkoGeoMemories - Local Server

pushd "%~dp0"
if errorlevel 1 (
    echo Cannot open the application folder.
    pause
    exit /b 1
)

echo Starting AdamenkoGeoMemories...
echo Open the address printed by the server in your browser.
echo Keep this window open. Press Ctrl+C to stop the server.
echo.

if exist "node_modules\node\bin\node.exe" (
    "node_modules\node\bin\node.exe" "scripts\run.cjs" start
) else (
    call npm.cmd start
)

set "server_exit_code=%errorlevel%"
echo.
echo Server stopped. Exit code: %server_exit_code%
popd
pause
exit /b %server_exit_code%
