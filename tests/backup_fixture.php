<?php
// Test-only authenticated legacy/malformed archives. Never served by the web server.
declare(strict_types=1);
require __DIR__ . '/../src/backup.php';
[$script, $source, $target, $mode] = $argv;
$pass = stream_get_contents(STDIN);
$in = fopen($source, 'rb');
backup_read($in, strlen(BACKUP_MAGIC));
$salt = backup_read($in, 16); $header = backup_read($in, 24);
$key = backup_key($pass, $salt);
$state = sodium_crypto_secretstream_xchacha20poly1305_init_pull($header, $key);
$payload = '';
while (!feof($in)) {
  $length = fread($in, 4); if ($length === '') break;
  [$bytes, $tag] = sodium_crypto_secretstream_xchacha20poly1305_pull($state, backup_read($in, unpack('N', $length)[1]), BACKUP_MAGIC);
  $payload .= $bytes;
}
fclose($in);
$length = unpack('N', substr($payload, 0, 4))[1];
$manifest = json_decode(substr($payload, 4, $length), true);
$offset = 4 + $length; $contents = [];
foreach ($manifest['files'] as $entry) { $contents[] = substr($payload, $offset, $entry['size']); $offset += $entry['size']; }
switch ($mode) {
  case 'legacy-schema':
  case 'legacy-request-reviewer':
    foreach ($manifest['files'] as $i => &$entry) {
      if ($entry['path'] !== 'police.db') continue;
      $temp = tempnam(sys_get_temp_dir(), 'sp-legacy-');
      try {
        file_put_contents($temp, $contents[$i]);
        $db = new PDO('sqlite:' . $temp, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        if ($mode === 'legacy-schema') {
          $db->exec('DROP INDEX IF EXISTS ux_users_email; ALTER TABLE users DROP COLUMN approval_status');
          $db->exec('ALTER TABLE users DROP COLUMN email');
          $db->exec('DROP TABLE IF EXISTS request_files; DROP TABLE IF EXISTS service_requests');
        } else {
          $db->exec('ALTER TABLE service_requests DROP COLUMN result_format');
          $db->exec('ALTER TABLE service_requests DROP COLUMN reviewer_id');
        }
        $db = null;
        $contents[$i] = file_get_contents($temp);
        $entry['size'] = strlen($contents[$i]); $entry['sha256'] = hash('sha256', $contents[$i]);
      } finally { @unlink($temp); }
    }
    unset($entry);
    break;
  case 'traversal': $manifest['files'][0]['path'] = '../escape'; break;
  case 'duplicate': $manifest['files'][1]['path'] = 'police.db'; break;
  case 'checksum': $manifest['files'][0]['sha256'] = str_repeat('0', 64); break;
  case 'missing-key':
  case 'missing-evidence':
    foreach ($manifest['files'] as $i => $entry) {
      if (($mode === 'missing-key' && $entry['path'] === 'master.key') ||
          ($mode === 'missing-evidence' && str_starts_with($entry['path'], 'vault/'))) {
        unset($manifest['files'][$i], $contents[$i]); break;
      }
    }
    $manifest['files'] = array_values($manifest['files']); $contents = array_values($contents);
    break;
  case 'wrong-key':
  case 'bad-db':
    foreach ($manifest['files'] as $i => &$entry) {
      if ($entry['path'] === ($mode === 'wrong-key' ? 'master.key' : 'police.db')) {
        $contents[$i][0] = chr(ord($contents[$i][0]) ^ 255);
        $entry['sha256'] = hash('sha256', $contents[$i]);
      }
    }
    unset($entry);
    break;
  case 'nonempty-final': break;
  default: throw new RuntimeException('Unknown fixture mode');
}
$json = json_encode($manifest);
$payload = pack('N', strlen($json)) . $json . implode('', $contents);
$salt = random_bytes(16); $key = backup_key($pass, $salt);
[$state, $header] = sodium_crypto_secretstream_xchacha20poly1305_init_push($key);
$out = fopen($target, 'wb'); backup_write($out, BACKUP_MAGIC . $salt . $header);
foreach (str_split($payload, BACKUP_CHUNK) as $bytes) {
  $cipher = sodium_crypto_secretstream_xchacha20poly1305_push($state, $bytes, BACKUP_MAGIC);
  backup_write($out, pack('N', strlen($cipher)) . $cipher);
}
$cipher = sodium_crypto_secretstream_xchacha20poly1305_push($state, $mode === 'nonempty-final' ? 'unexpected' : '', BACKUP_MAGIC, SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL);
backup_write($out, pack('N', strlen($cipher)) . $cipher);
fclose($out);
