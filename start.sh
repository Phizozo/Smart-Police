#!/bin/sh
cd "$(dirname "$0")"
PORT=${1:-5000}
if [ ! -f node_modules/pdfjs-dist/build/pdf.mjs ] || [ ! -f node_modules/pdf-lib/package.json ] || [ ! -f node_modules/@pdf-lib/fontkit/package.json ] || [ ! -f node_modules/echarts/package.json ] || [ ! -f node_modules/@replit/connectors-sdk/package.json ] || [ ! -f node_modules/exceljs/package.json ]; then
  if [ "${2:-}" = "--prebuilt" ]; then
    echo "Deployment dependencies are missing. Run the configured publishing build step before starting."
    exit 1
  fi
  command -v npm >/dev/null || { echo "Node.js/npm is required to install the local PDF viewer."; exit 1; }
  npm ci --omit=dev --omit=optional || exit 1
fi
command -v php >/dev/null || { echo "PHP not found. Install PHP 8.4+ (php-cli php-sqlite3 php-mbstring)."; exit 1; }
if [ ! -f vendor/autoload.php ]; then
  if [ "${2:-}" = "--prebuilt" ]; then
    echo "Deployment PHP dependencies are missing. Run the configured publishing build step before starting."
    exit 1
  fi
  command -v composer >/dev/null || { echo "Composer is required to install WebAuthn dependencies."; exit 1; }
  composer install --no-interaction --prefer-dist || exit 1
fi
if command -v g++ >/dev/null && { [ ! -x bin/stamper ] || [ src/stamper.cpp -nt bin/stamper ]; }; then
  g++ -O2 -std=c++17 -o bin/stamper src/stamper.cpp || exit 1
fi
echo "Smart Police is listening on port $PORT (Ctrl+C to stop)"
exec php -d upload_max_filesize=12M -d post_max_size=44M -S "0.0.0.0:$PORT" -t public
