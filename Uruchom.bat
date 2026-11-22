@echo off
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist "node_modules\electron\dist\electron.exe" (
  echo Instaluje zaleznosci...
  call npm install
  node node_modules\electron\install.js
)
start "" "node_modules\electron\dist\electron.exe" .
