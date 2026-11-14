#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f package-lock.json ]; then
  npm ci --omit=dev --omit=optional
fi

echo "Checking PHP syntax..."
for file in public/api.php public/pdfjs.php src/lib.php src/pdf.php src/backup.php src/reports.php src/passkeys.php src/requests.php src/request-stamp.php src/document-preview.php tools/restore.php; do
  php -l "$file"
done

echo "Building PDF stamper..."
make all

echo "Running API smoke tests..."
python3 tests/api_smoke.py

echo "Running encrypted backup and recovery tests..."
python3 tests/backup_recovery.py

echo "Running validation, database, login security and reporting tests..."
python3 tests/security_reports.py

echo "Running Citizen service and identity-file privacy tests..."
python3 tests/service_requests.py

echo "Post-merge setup completed."
