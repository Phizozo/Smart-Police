<?php
declare(strict_types=1);

// SPBK v1: fixed Argon2id parameters, authenticated secretstream frames, then
// a final empty frame. Inside: a length-prefixed manifest followed by file bytes.
const BACKUP_MAGIC = "SPBK\x01\r\n";
const BACKUP_CHUNK = 65536;
const BACKUP_MANIFEST_MAX = 8 * 1024 * 1024;
const BACKUP_MAX_BYTES = 20 * 1024 * 1024 * 1024;

function backup_write($stream, string $bytes): void {
  while ($bytes !== '') {
    $n = fwrite($stream, $bytes);
    if (!$n) throw new RuntimeException('Unable to write backup; check free disk space.');
    $bytes = substr($bytes, $n);
  }
}
function backup_read($stream, int $length): string {
  $bytes = '';
  while (strlen($bytes) < $length) {
    $part = fread($stream, $length - strlen($bytes));
    if ($part === false || $part === '') throw new RuntimeException('Backup is truncated.');
    $bytes .= $part;
  }
  return $bytes;
}
function backup_lock(string $data, bool $exclusive) {
  $parent = dirname($data);
  if (!is_dir($parent) || is_link($data)) throw new RuntimeException('Data parent must exist and data must not be a symlink.');
  $path = $data . '.lock';
  if (is_link($path)) throw new RuntimeException('Unsafe data lock.');
  $f = fopen($path, 'c');
  if (!$f || !chmod($path, 0600) || !flock($f, $exclusive ? LOCK_EX : LOCK_SH)) throw new RuntimeException('Cannot lock case storage.');
  return $f; // held until request/command ends, outside the swappable data directory
}
function backup_workspace(string $data): string {
  // Only call under the exclusive data lock, so no active workspace is removed.
  foreach (glob($data . '.recovery-*', GLOB_ONLYDIR) ?: [] as $old) {
    if (!is_link($old) && preg_match('/\.recovery-[a-f0-9]{24}$/D', $old) && filemtime($old) < time() - 86400) {
      // Network transfers no longer hold the storage lock; their own lease
      // prevents expiry cleanup from removing a still-active download.
      $lease = is_file($old . '/.streaming') ? fopen($old . '/.streaming', 'rb') : null;
      if ($lease && !flock($lease, LOCK_EX | LOCK_NB)) { fclose($lease); continue; }
      try { backup_remove($old); } finally { if ($lease) fclose($lease); }
    }
  }
  $dir = $data . '.recovery-' . bin2hex(random_bytes(12));
  if (!mkdir($dir, 0700)) throw new RuntimeException('Cannot create private recovery workspace.');
  return $dir;
}
function backup_remove(string $dir): void {
  if (!is_dir($dir) || is_link($dir)) throw new RuntimeException('Unsafe recovery workspace.');
  foreach (new FilesystemIterator($dir) as $file) {
    if ($file->isDir() && !$file->isLink()) backup_remove($file->getPathname());
    elseif (!unlink($file->getPathname())) throw new RuntimeException('Cannot remove recovery temporary file.');
  }
  if (!rmdir($dir)) throw new RuntimeException('Cannot remove recovery workspace.');
}
function backup_key(string $passphrase, string $salt): string {
  if (!function_exists('sodium_crypto_secretstream_xchacha20poly1305_init_push')) throw new RuntimeException('PHP sodium is required for recovery backups.');
  return sodium_crypto_pwhash(32, $passphrase, $salt, 3, 64 * 1024 * 1024, SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13);
}
function backup_path(string $path): bool {
  return in_array($path, ['police.db', 'master.key'], true) || preg_match('~^vault/[a-f0-9]{32}\.enc$~D', $path) === 1;
}

// Checks both SQLite consistency and the database-to-file relationships.
function backup_validate(string $dir): array {
  $key = file_get_contents($dir . '/master.key');
  if ($key === false || strlen($key) !== 32) throw new RuntimeException('Invalid master key.');
  $db = new PDO('sqlite:' . $dir . '/police.db', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
  $db->exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
  if ($db->query('PRAGMA integrity_check')->fetchAll(PDO::FETCH_COLUMN) !== ['ok'] ||
      $db->query('PRAGMA foreign_key_check')->fetchAll()) throw new RuntimeException('Database integrity check failed.');
  $expected = ['users', 'cases', 'case_events', 'evidence', 'affidavits', 'sos', 'audit', 'admin_lock', 'pdf_exports'];
  $tables = $db->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")->fetchAll(PDO::FETCH_COLUMN);
  // Older archives predate standalone requests; either both new tables exist or neither.
  $hasRequests = in_array('service_requests', $tables, true);
  if ($hasRequests !== in_array('request_files', $tables, true)) throw new RuntimeException('Incomplete request schema.');
  if ($hasRequests) array_push($expected, 'service_requests', 'request_files');
  sort($expected); sort($tables);
  if ($tables !== $expected || $db->query("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view')")->fetchColumn()) throw new RuntimeException('Unsupported database schema.');
  $reference = new PDO('sqlite::memory:');
  $reference->exec(file_get_contents(__DIR__ . '/../schema.sql'));
  $reference->exec('CREATE TABLE pdf_exports(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,case_id INTEGER,filename TEXT NOT NULL,vault TEXT NOT NULL,sha256 TEXT NOT NULL,created INTEGER NOT NULL)');
  $reference->exec(file_get_contents(__DIR__ . '/requests-schema.sql'));
  foreach ($expected as $table) {
    $actualColumns = $db->query("PRAGMA table_info($table)")->fetchAll(PDO::FETCH_ASSOC);
    $expectedColumns = $reference->query("PRAGMA table_info($table)")->fetchAll(PDO::FETCH_ASSOC);
    // Legacy archives predate staff approvals; their existing accounts remain active.
    if ($table === 'users') {
      $actualNames = array_column($actualColumns, 'name');
      $expectedColumns = array_values(array_filter($expectedColumns, static fn($column) =>
      !in_array($column['name'], ['approval_status', 'email', 'residential_address', 'phone', 'suspended', 'suspension_reason', 'suspended_at', 'suspended_by', 'passkey_user_handle', 'passkey_credential', 'passkey_label', 'passkey_created', 'passkey_last_used', 'admin_setup_hash', 'admin_setup_expires', 'two_step_enabled', 'face_vault', 'face_sha256', 'face_mime', 'face_updated'], true) || in_array($column['name'], $actualNames, true)));
    }
    if ($table === 'service_requests') {
      $actualNames = array_column($actualColumns,'name');
      $expectedColumns = array_values(array_filter($expectedColumns, static fn($column) =>
        !in_array($column['name'],['reviewer_id','result_format'],true) || in_array($column['name'],$actualNames,true)));
    }
    $normaliseColumns = static fn(array $columns): array => array_map(static function(array $column): array {
      unset($column['cid']); return $column;
    }, $columns);
    if ($normaliseColumns($actualColumns) !== $normaliseColumns($expectedColumns)) throw new RuntimeException('Unsupported database columns in ' . $table . '.');
  }
  $hasApproval = in_array('approval_status', $db->query('PRAGMA table_info(users)')->fetchAll(PDO::FETCH_COLUMN, 1), true);
  $userColumns = $db->query('PRAGMA table_info(users)')->fetchAll(PDO::FETCH_COLUMN, 1);
  $hasSetup = in_array('admin_setup_hash', $userColumns, true);
  if ($hasSetup !== in_array('admin_setup_expires', $userColumns, true)) throw new RuntimeException('Incomplete Admin setup metadata.');
  if ($hasSetup) {
    foreach ($db->query('SELECT role,admin_setup_hash,admin_setup_expires FROM users') as $row) {
      if (($row['admin_setup_hash'] === null) !== ($row['admin_setup_expires'] === null) ||
          ($row['admin_setup_hash'] !== null && ($row['role'] !== 'admin' ||
          !preg_match('/^[a-f0-9]{64}$/D', $row['admin_setup_hash']) ||
          !is_int($row['admin_setup_expires']) || $row['admin_setup_expires'] < 1))) {
        throw new RuntimeException('Invalid Admin password setup metadata.');
      }
    }
  }
  if (in_array('email', $userColumns, true)) {
    $emails = [];
    foreach ($db->query("SELECT email,role FROM users WHERE email IS NOT NULL AND email<>''") as $row) {
      $email = strtolower($row['email']);
      $domain = $row['role'] === 'admin' ? '@admin.co.za' : ($row['role'] === 'citizen' ? '@gmail.com' : null);
      if (!filter_var($email, FILTER_VALIDATE_EMAIL) || ($domain && !str_ends_with($email, $domain)) || isset($emails[$email])) throw new RuntimeException('Invalid account email.');
      $emails[$email] = true;
    }
  }
  if (in_array('phone', $userColumns, true) && $db->query("SELECT 1 FROM users WHERE role='citizen' AND phone IS NOT NULL AND phone NOT GLOB '+27[1-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' LIMIT 1")->fetchColumn()) throw new RuntimeException('Invalid citizen phone number.');
  $faceColumns = ['face_vault','face_sha256','face_mime','face_updated'];
  $hasFaceFields = array_intersect($faceColumns, $userColumns);
  if ($hasFaceFields && count($hasFaceFields) !== count($faceColumns)) throw new RuntimeException('Incomplete Citizen camera-photo metadata.');
  if ($hasFaceFields) {
    if ($db->query("SELECT 1 FROM users WHERE (face_vault IS NULL AND (face_sha256 IS NOT NULL OR face_mime IS NOT NULL OR face_updated IS NOT NULL)) OR (face_vault IS NOT NULL AND (role!='citizen' OR face_sha256 IS NULL OR face_sha256 NOT GLOB '[a-f0-9]*' OR length(face_sha256)!=64 OR face_mime NOT IN('image/jpeg','image/png') OR face_updated IS NULL OR face_updated<1)) LIMIT 1")->fetchColumn()) throw new RuntimeException('Invalid Citizen camera-photo metadata.');
    foreach ($db->query('SELECT face_vault,face_sha256 FROM users WHERE face_vault IS NOT NULL') as $row) $refs[] = [$row['face_vault'], $row['face_sha256'], null];
  }
  if ($hasApproval && $db->query("SELECT 1 FROM users WHERE approval_status NOT IN ('active','pending','rejected') OR approval_status IS NULL")->fetchColumn()) throw new RuntimeException('Invalid account approval state.');
  if (!(int)$db->query("SELECT COUNT(*) FROM users WHERE role='admin'" . ($hasApproval ? " AND approval_status='active'" : ''))->fetchColumn()) throw new RuntimeException('Backup has no active administrator.');
  $refs = [];
  foreach ($db->query('SELECT vault,size FROM evidence') as $row) $refs[] = [$row['vault'], null, (int)$row['size']];
  foreach ($db->query('SELECT vault,sha256,stamped_vault,status FROM affidavits') as $row) {
    $refs[] = [$row['vault'], $row['sha256'], null];
    if ($row['status'] === 'Certified' && !$row['stamped_vault']) throw new RuntimeException('Certified affidavit is missing its stamped PDF.');
    if ($row['stamped_vault']) $refs[] = [$row['stamped_vault'], null, null];
  }
  foreach ($db->query('SELECT vault,sha256 FROM pdf_exports') as $row) $refs[] = [$row['vault'], $row['sha256'], null];
  if ($hasRequests) {
    if ($db->query("SELECT 1 FROM service_requests r WHERE (r.kind='affidavit' AND NOT EXISTS(SELECT 1 FROM request_files f WHERE f.request_id=r.id AND f.kind='id_proof')) OR NOT EXISTS(SELECT 1 FROM request_files f WHERE f.request_id=r.id AND f.kind='selfie') OR (r.kind='certification' AND (NOT EXISTS(SELECT 1 FROM request_files f WHERE f.request_id=r.id AND f.kind='original') OR NOT EXISTS(SELECT 1 FROM request_files f WHERE f.request_id=r.id AND f.kind='copy'))) LIMIT 1")->fetchColumn()) throw new RuntimeException('A request is missing required identity or source documents.');
    foreach ($db->query('SELECT * FROM service_requests') as $row) {
      $refs[] = [$row['details_vault'], $row['details_sha256'], null];
      if (!$row['receipt_vault'] || !$row['receipt_sha256']) throw new RuntimeException('A request receipt is missing.');
      $refs[] = [$row['receipt_vault'], $row['receipt_sha256'], null];
      if ($row['status'] === 'Approved' && (!$row['result_vault'] || !$row['result_sha256'])) throw new RuntimeException('An approved request record is missing.');
      $format=$row['result_format'] ?? 'review_record';
      if (!in_array($format,['review_record','stamped_document'],true) || ($format==='stamped_document' && $row['status']!=='Approved')) throw new RuntimeException('Invalid approved document format.');
      $reviewerId = array_key_exists('reviewer_id', $row) ? $row['reviewer_id'] : $row['officer_id'];
      if ($row['status'] === 'Approved' && (!$row['identity_checked'] || !$row['documents_checked'] || !$reviewerId || !$row['reviewed_at'])) throw new RuntimeException('An approved request is missing its authorised review.');
      if ($row['result_vault']) $refs[] = [$row['result_vault'], $row['result_sha256'], null];
    }
    foreach ($db->query('SELECT vault,sha256,size FROM request_files') as $row) $refs[] = [$row['vault'], $row['sha256'], (int)$row['size']];
  }
  $plainInfo = [];
  foreach (new FilesystemIterator($dir . '/vault') as $file) {
    if ($file->isLink() || !$file->isFile() || !backup_path('vault/' . $file->getFilename())) throw new RuntimeException('Unexpected vault entry.');
    // Application uploads are limited to 10 MB; avoid unbounded per-file memory.
    if ($file->getSize() < 28 || $file->getSize() > 64 * 1024 * 1024) throw new RuntimeException('Unsupported vault file size (maximum 64 MB).');
    $bytes = file_get_contents($file->getPathname());
    $plain = openssl_decrypt(substr($bytes, 28), 'aes-256-gcm', $key, OPENSSL_RAW_DATA, substr($bytes, 0, 12), substr($bytes, 12, 16));
    if ($plain === false) throw new RuntimeException('Vault authentication failed.');
    $plainInfo[$file->getFilename()] = [hash('sha256', $plain), strlen($plain)];
    unset($plain, $bytes);
  }
  foreach ($refs as [$name, $sha, $size]) {
    if (!is_string($name) || !backup_path('vault/' . $name) || !isset($plainInfo[$name])) throw new RuntimeException('A referenced attachment is missing.');
    [$actualHash, $actualSize] = $plainInfo[$name];
    if (($sha !== null && !hash_equals($sha, $actualHash)) || ($size !== null && $size !== $actualSize)) throw new RuntimeException('Attachment content does not match its record.');
  }
  $counts = [];
  foreach ($expected as $table) $counts[$table] = (int)$db->query("SELECT COUNT(*) FROM $table")->fetchColumn();
  return $counts;
}

// Caller holds an exclusive storage lock. No persistent backup archive is retained.
function backup_create(PDO $db, string $data, string $passphrase, string $work): string {
  if (strlen($passphrase) < 16 || strlen($passphrase) > 1024 || strpbrk($passphrase, "\r\n") !== false) throw new InvalidArgumentException('Use a single-line backup passphrase of 16 to 1,024 bytes.');
  if (is_link($data . '/vault') || is_link($data . '/police.db')) throw new RuntimeException('Vault and database must not be symlinks.');
  $snapshot = $work . '/police.db';
  $db->exec('VACUUM INTO ' . $db->quote($snapshot));
  chmod($snapshot, 0600);
  $paths = ['police.db' => $snapshot, 'master.key' => $data . '/master.key'];
  foreach (new FilesystemIterator($data . '/vault') as $file) {
    if ($file->isLink() || !$file->isFile() || !backup_path('vault/' . $file->getFilename())) throw new RuntimeException('Unexpected vault entry; backup cancelled.');
    $paths['vault/' . $file->getFilename()] = $file->getPathname();
  }
  if (is_link($paths['master.key']) || !is_file($paths['master.key']) || filesize($paths['master.key']) !== 32) throw new RuntimeException('Master key is missing or invalid.');
  $entries = []; $total = 0;
  foreach ($paths as $path => $source) {
    $size = filesize($source); $hash = hash_file('sha256', $source);
    if ($size === false || $hash === false) throw new RuntimeException('Cannot read backup source.');
    $total += $size;
    $entries[] = ['path' => $path, 'size' => $size, 'sha256' => $hash];
  }
  if ($total > BACKUP_MAX_BYTES || count($entries) > 50000) throw new RuntimeException('Backup exceeds the supported 20 GB / 50,000 file limit.');
  $manifest = json_encode(['format' => 1, 'created' => gmdate('c'), 'files' => $entries], JSON_THROW_ON_ERROR);
  if (strlen($manifest) > BACKUP_MANIFEST_MAX) throw new RuntimeException('Backup manifest is too large.');
  $salt = random_bytes(SODIUM_CRYPTO_PWHASH_SALTBYTES);
  $key = backup_key($passphrase, $salt);
  [$state, $header] = sodium_crypto_secretstream_xchacha20poly1305_init_push($key);
  sodium_memzero($key);
  $output = $work . '/backup.spbk'; $out = fopen($output, 'xb'); chmod($output, 0600);
  try {
    backup_write($out, BACKUP_MAGIC . $salt . $header);
    $push = function(string $bytes, bool $final = false) use (&$state, $out): void {
      $cipher = sodium_crypto_secretstream_xchacha20poly1305_push($state, $bytes, BACKUP_MAGIC, $final ? SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL : 0);
      backup_write($out, pack('N', strlen($cipher)) . $cipher);
    };
    $prefix = pack('N', strlen($manifest)) . $manifest;
    foreach (str_split($prefix, BACKUP_CHUNK) as $chunk) $push($chunk);
    foreach ($paths as $source) {
      $in = fopen($source, 'rb');
      try {
        while (!feof($in)) {
          $chunk = fread($in, BACKUP_CHUNK);
          if ($chunk === false) throw new RuntimeException('Cannot read backup source.');
          if ($chunk !== '') $push($chunk);
        }
      } finally { fclose($in); }
    }
    $push('', true);
  } finally { fclose($out); }
  return $output;
}

// Extract only allowlisted paths into an empty private directory; never into live data.
function backup_extract(string $archive, string $passphrase, string $stage): array {
  if (!is_file($archive) || filesize($archive) > BACKUP_MAX_BYTES + 64 * 1024 * 1024) throw new RuntimeException('Backup is missing or too large.');
  $in = fopen($archive, 'rb');
  try {
    if (backup_read($in, strlen(BACKUP_MAGIC)) !== BACKUP_MAGIC) throw new RuntimeException('Unsupported backup format.');
    $salt = backup_read($in, SODIUM_CRYPTO_PWHASH_SALTBYTES);
    $header = backup_read($in, SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_HEADERBYTES);
    $key = backup_key($passphrase, $salt);
    $state = sodium_crypto_secretstream_xchacha20poly1305_init_pull($header, $key);
    sodium_memzero($key);
    $buffer = ''; $final = false;
    $read = function(int $length) use ($in, &$state, &$buffer, &$final): string {
      while (strlen($buffer) < $length && !$final) {
        $n = unpack('N', backup_read($in, 4))[1];
        if ($n < 17 || $n > BACKUP_CHUNK + 17) throw new RuntimeException('Invalid backup frame length.');
        $result = sodium_crypto_secretstream_xchacha20poly1305_pull($state, backup_read($in, $n), BACKUP_MAGIC);
        if ($result === false) throw new RuntimeException('Wrong passphrase or damaged backup.');
        [$plain, $tag] = $result;
        $final = $tag === SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL;
        if (($final && $plain !== '') || (!$final && ($tag !== 0 || $plain === ''))) throw new RuntimeException('Invalid backup frame.');
        $buffer .= $plain;
      }
      if (strlen($buffer) < $length) throw new RuntimeException('Backup content is incomplete.');
      $result = substr($buffer, 0, $length); $buffer = substr($buffer, $length);
      return $result;
    };
    $length = unpack('N', $read(4))[1];
    if ($length < 2 || $length > BACKUP_MANIFEST_MAX) throw new RuntimeException('Invalid manifest size.');
    $manifest = json_decode($read($length), true, 64, JSON_THROW_ON_ERROR);
    if (($manifest['format'] ?? null) !== 1 || !is_array($manifest['files'] ?? null) || count($manifest['files']) > 50000) throw new RuntimeException('Unsupported manifest.');
    $seen = []; $total = 0;
    foreach ($manifest['files'] as $entry) {
      $path = $entry['path'] ?? null; $size = $entry['size'] ?? null; $sha = $entry['sha256'] ?? null;
      if (!is_string($path) || !backup_path($path) || isset($seen[$path]) || !is_int($size) || $size < 0 ||
          !is_string($sha) || !preg_match('/^[a-f0-9]{64}$/D', $sha)) throw new RuntimeException('Unsafe or invalid manifest entry.');
      $seen[$path] = true; $total += $size;
      if ($total > BACKUP_MAX_BYTES) throw new RuntimeException('Backup exceeds 20 GB limit.');
    }
    if (!isset($seen['police.db'], $seen['master.key'])) throw new RuntimeException('Database or master key is missing.');
    mkdir($stage . '/vault', 0700);
    foreach ($manifest['files'] as $entry) {
      $out = fopen($stage . '/' . $entry['path'], 'xb'); chmod($stage . '/' . $entry['path'], 0600);
      $hash = hash_init('sha256'); $left = $entry['size'];
      try {
        while ($left > 0) {
          $bytes = $read(min(BACKUP_CHUNK, $left)); $left -= strlen($bytes);
          hash_update($hash, $bytes); backup_write($out, $bytes);
        }
      } finally { fclose($out); }
      if (!hash_equals($entry['sha256'], hash_final($hash))) throw new RuntimeException('Backup file checksum failed.');
    }
    // Require exactly one empty authenticated final frame, followed by EOF.
    if ($final || $buffer !== '' || unpack('N', backup_read($in, 4))[1] !== 17) throw new RuntimeException('Backup has trailing content.');
    $end = sodium_crypto_secretstream_xchacha20poly1305_pull($state, backup_read($in, 17), BACKUP_MAGIC);
    if ($end !== ['', SODIUM_CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_FINAL] || fread($in, 1) !== '') throw new RuntimeException('Backup has trailing data or no final authentication tag.');
    $counts = backup_validate($stage);
    return ['created' => $manifest['created'] ?? '', 'files' => count($seen), 'records' => $counts];
  } finally { fclose($in); }
}

function backup_install(string $data, string $stage): ?string {
  // The caller must stop the application AND hold the exclusive storage lock.
  // All integrity validation must have succeeded before this function is called.
  mkdir($stage . '/tmp', 0700);
  file_put_contents($stage . '/session.epoch', bin2hex(random_bytes(32))); chmod($stage . '/session.epoch', 0600);
  $db = new PDO('sqlite:' . $stage . '/police.db', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
  $db->exec('DELETE FROM admin_lock');
  $db->prepare("INSERT INTO audit(ts,action,detail) VALUES(?,'backup.restore',?)")->execute([time(), 'Verified encrypted recovery archive restored; prior sessions invalidated']);
  $db = null;
  $rollback = null;
  if (file_exists($data)) {
    if (!is_dir($data) || !chmod($data, 0700)) throw new RuntimeException('Cannot protect existing data directory; nothing replaced.');
    $rollback = $data . '.rollback-' . gmdate('Ymd-His') . '-' . bin2hex(random_bytes(4));
    if (!rename($data, $rollback)) throw new RuntimeException('Cannot preserve existing data; nothing replaced.');
  }
  if (!rename($stage, $data)) {
    if ($rollback !== null && !rename($rollback, $data)) throw new RuntimeException("Install failed. Restore preserved directory manually: $rollback");
    throw new RuntimeException('Install failed; previous data restored.');
  }
  return $rollback;
}
