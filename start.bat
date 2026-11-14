@echo off
cd /d "%~dp0"
set PORT=%1
node -e "require.resolve('pdfjs-dist/package.json');require.resolve('pdf-lib');require.resolve('@pdf-lib/fontkit');require.resolve('echarts')" >nul 2>&1
if errorlevel 1 (
  where npm >nul 2>nul || (echo Install Node.js 24+ to install the local PDF viewer. & pause & exit /b 1)
  call npm ci --omit=dev --omit=optional || exit /b 1
)
if "%PORT%"=="" set PORT=8080
where php >nul 2>nul || (echo PHP was not found. Install PHP 8.4+ and add it to PATH, then run this again. & pause & exit /b 1)
php -r "exit(extension_loaded('pdo_sqlite')&&extension_loaded('openssl')&&extension_loaded('mbstring')?0:1);" || (echo Enable pdo_sqlite, openssl and mbstring in php.ini - remove the leading semicolon - then run this again. & pause & exit /b 1)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%"
echo Smart Police is running at http://localhost:%PORT%  (close this window to stop it)
php -d upload_max_filesize=12M -d post_max_size=44M -S localhost:%PORT% -t public
