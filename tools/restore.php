<?php
declare(strict_types=1);
require __DIR__ . '/../src/backup.php';

if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
if ($argc < 3 || !in_array($argv[1], ['verify', 'restore'], true) ||
    ($argv[1] === 'restore' && ($argv[3] ?? '') !== '--replace-data')) {
  fwrite(STDERR, "Usage: php tools/restore.php verify ARCHIVE\n       php tools/restore.php restore ARCHIVE --replace-data\nRead the backup passphrase from standard input. Stop the application before restore.\n");
  exit(2);
}
umask(0077);
$data = rtrim(getenv('SMART_POLICE_DATA') ?: __DIR__ . '/../data', '/');
$work = null;
try {
  if (!function_exists('sodium_crypto_pwhash')) throw new RuntimeException('PHP sodium extension is required.');
  $passphrase = rtrim(stream_get_contents(STDIN, 1026), "\r\n");
  if (strlen($passphrase) < 16 || strlen($passphrase) > 1024) throw new RuntimeException('Passphrase must be 16 to 1,024 bytes.');
  $lock = backup_lock($data, true);
  $work = backup_workspace($data);
  $result = backup_extract($argv[2], $passphrase, $work);
  sodium_memzero($passphrase);
  echo 'Verified: ' . json_encode($result, JSON_THROW_ON_ERROR) . PHP_EOL;
  if ($argv[1] === 'restore') {
    $rollback = backup_install($data, $work); $work = null;
    echo "Restore complete. All users must sign in again.\n";
    if (getenv('SP_ONEDRIVE_ROSTER_SYNC') !== '0') {
      try {
        if (!defined('DATA')) define('DATA', $data);
        require_once __DIR__ . '/../src/registration-roster.php';
        $restoredDb = new PDO('sqlite:' . $data . '/police.db', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $sync = registration_roster_sync($restoredDb);
        if (!empty($sync['synced'])) {
          echo 'OneDrive workbook refreshed: ' . (int)$sync['sheet_count'] . ' sheets, ' . (int)$sync['row_count'] . " records.\n";
        } else {
          fwrite(STDERR, "Restore succeeded, but the OneDrive workbook was not refreshed. Start the app and retry from Admin Settings.\n");
        }
      } catch (Throwable $syncError) {
        fwrite(STDERR, "Restore succeeded, but the OneDrive workbook could not be refreshed. Start the app and retry from Admin Settings.\n");
        error_log('OneDrive sync after recovery restore failed: ' . $syncError->getMessage());
      }
    }
    if ($rollback !== null) echo "Previous data retained at: $rollback\nDelete it within 24 hours after successful recovery checks (see docs/backup-recovery.md).\n";
  }
} catch (Throwable $e) {
  fwrite(STDERR, 'Recovery failed: ' . $e->getMessage() . PHP_EOL);
  $failed = true;
} finally {
  if ($work !== null) backup_remove($work);
}
exit(isset($failed) ? 1 : 0);
