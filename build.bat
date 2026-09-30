@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  if not exist "tools\node-v24.19.0-win-x64\node.exe" (
    if not exist tools mkdir tools
    curl.exe --fail --location --retry 2 --output "tools\node.zip" "https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip"
    if errorlevel 1 exit /b 1
    tar -xf "tools\node.zip" -C tools
    if errorlevel 1 exit /b 1
  )
  set "PATH=%CD%\tools\node-v24.19.0-win-x64;%PATH%"
)

if not exist "tools\npm-11.20.0\bin\npm-cli.js" (
  if not exist "tools\npm-11.20.0" mkdir "tools\npm-11.20.0"
  curl.exe --fail --location --retry 2 --output "tools\npm-11.20.0.tgz" "https://registry.npmjs.org/npm/-/npm-11.20.0.tgz"
  if errorlevel 1 exit /b 1
  tar -xzf "tools\npm-11.20.0.tgz" -C "tools\npm-11.20.0" --strip-components=1
  if errorlevel 1 exit /b 1
)

node npm/prepare.mjs
if errorlevel 1 exit /b 1
node tools/npm-11.20.0/bin/npm-cli.js pack ./build/npm --pack-destination ./build
exit /b %ERRORLEVEL%
