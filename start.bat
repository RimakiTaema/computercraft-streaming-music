@echo off
setlocal enabledelayedexpansion

echo [+] iPod API - Windows Setup
echo.

:: Check pm2
where pm2 >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [x] pm2 not found. Install with: npm i -g pm2
    pause
    exit /b 1
)

:: Check node
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [x] node not found. Install Node.js first.
    pause
    exit /b 1
)

:: Create logs dir
if not exist logs mkdir logs

:: Install API dependencies
echo [+] Installing API dependencies...
cd functions
call npm install --omit=dev
if %ERRORLEVEL% neq 0 (
    echo [x] Failed to install API dependencies
    cd ..
    pause
    exit /b 1
)
cd ..

:: Install web dependencies
echo [+] Installing web dependencies...
cd web
call npm install --omit=dev
if %ERRORLEVEL% neq 0 (
    echo [x] Failed to install web dependencies
    cd ..
    pause
    exit /b 1
)

:: Build web
echo [+] Building web dashboard...
call npx next build
if %ERRORLEVEL% neq 0 (
    echo [x] Failed to build web dashboard
    cd ..
    pause
    exit /b 1
)
cd ..

:: Check .env
if not exist functions\.env (
    echo [!] functions\.env not found - creating template
    (
        echo RAPIDAPI_API_KEYS=
        echo GITHUB_OWNER=
        echo GITHUB_REPO=
        echo PORT=8080
    ) > functions\.env
    echo [!] Edit functions\.env with your settings before first use
)

:: Start with pm2
echo [+] Starting services with pm2...
call pm2 start ecosystem.config.cjs

echo.
call pm2 status
echo.
echo [+] API:       http://localhost:8080
echo [+] Dashboard: http://localhost:3000
echo.
echo Useful commands:
echo   pm2 logs          - View all logs
echo   pm2 logs ipod-api - View API logs only
echo   pm2 monit         - Real-time monitoring
echo   pm2 restart all   - Restart services
echo   pm2 stop all      - Stop services
echo   pm2 save          - Save process list for boot
echo   pm2 startup       - Generate boot startup script
echo.
pause
