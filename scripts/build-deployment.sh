#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

# Install while the publishing build environment can reach the package registry.
# The published server must not download packages before opening its HTTP port.
npm ci --omit=dev --omit=optional
composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader
composer check-platform-reqs --no-dev

for asset in \
  node_modules/pdfjs-dist/build/pdf.mjs \
  node_modules/pdf-lib/package.json \
  node_modules/@pdf-lib/fontkit/package.json \
  node_modules/echarts/package.json \
  node_modules/@replit/connectors-sdk/package.json \
  node_modules/exceljs/package.json \
  scripts/onedrive-registration-roster.mjs \
  vendor/autoload.php
do
  test -f "$asset" || { echo "Missing deployment dependency: $asset"; exit 1; }
done
echo "Publishing dependencies are ready."
