@echo off
REM Runs elevated (admin) so electron-builder's winCodeSign symlinks unpack.
set "DESK=C:\Users\Jane Doe\Desktop\Projects\AI Infrastructure\model Bridge\jac\desktop"
REM free anything locking the previous build output
taskkill /F /IM JAC.exe 2>nul
taskkill /F /IM llama-server.exe 2>nul
cd /d "%DESK%"
set "PATH=C:\Users\Jane Doe\nodejs\node-v22.11.0-win-x64;%PATH%"
set CSC_IDENTITY_AUTO_DISCOVERY=false
REM nuke the half-extracted winCodeSign cache so it re-downloads + extracts cleanly (now with privilege)
rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" 2>nul
echo Building JAC installer... this window closes when done (2-3 min).
call npx electron-builder --win > "%DESK%\pkg-elevated.log" 2>&1
echo DONE_%ERRORLEVEL%> "%DESK%\pkg-elevated.done"
