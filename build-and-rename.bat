@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   WCW Build Script
echo ============================================
echo.

where npm >nul 2>&1
if errorlevel 1 goto NoNpm

echo [1/2] Installing dependencies (first run may take a while)...
echo.
call npm install
if errorlevel 1 goto InstallFail

echo.
echo [2/2] Building (this can take a few minutes)...
echo.
call npm run build
if errorlevel 1 goto BuildFail

for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set VER=%%v
if "%VER%"=="" goto NoVer

if exist "dist\WCW-%VER%.exe" goto BuildOk
goto NoExe

:BuildOk
echo.
echo ============================================
echo   Build complete!
echo   dist\WCW-%VER%.exe is ready.
echo   Upload that file to your GitHub Release.
echo ============================================
goto End

:NoNpm
echo [ERROR] npm was not found on this computer.
echo Node.js does not seem to be installed.
echo Install it from https://nodejs.org and run this again.
goto End

:InstallFail
echo.
echo ============================================
echo   npm install failed. See the messages above.
echo ============================================
goto End

:BuildFail
echo.
echo ============================================
echo   Build failed. See the messages above.
echo ============================================
goto End

:NoVer
echo.
echo ============================================
echo   Could not read the version from package.json.
echo   Check the dist folder manually.
echo ============================================
goto End

:NoExe
echo.
echo ============================================
echo   Build finished but dist\WCW-%VER%.exe
echo   was not found. Please check the dist folder.
echo ============================================
goto End

:End
echo.
pause
