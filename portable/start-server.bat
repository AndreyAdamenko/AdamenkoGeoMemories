@echo off
setlocal
title AdamenkoGeoMemories - Portable Photo Atlas
pushd "%~dp0"
if errorlevel 1 exit /b 1

if not exist "node_modules\node\bin\node.exe" (
    echo Local Node.js not found. Copy the complete _GeoMemories folder.
    popd
    pause
    exit /b 1
)

echo Starting the portable photo atlas...
echo Open the local address printed below in your browser.
echo Keep this window open. Press Ctrl+C to stop the server.
echo.
"node_modules\node\bin\node.exe" "server\index.ts"
set "server_exit_code=%errorlevel%"
echo.
echo Server stopped. Exit code: %server_exit_code%
popd
pause
exit /b %server_exit_code%
