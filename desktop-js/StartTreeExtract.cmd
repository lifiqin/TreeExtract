@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" goto missing
if not exist "runtime\TreeExtractorBridge.exe" goto missing
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0

:missing
echo The desktop runtime is missing. Run scripts\setup.ps1 first.
pause
exit /b 1
