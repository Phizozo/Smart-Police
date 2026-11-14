<?php
declare(strict_types=1);
define('DATA', getenv('SMART_POLICE_DATA') ?: __DIR__ . '/../data');
date_default_timezone_set('Africa/Johannesburg');
ini_set('session.cookie_httponly', '1'); ini_set('session.cookie_samesite', 'Strict'); ini_set('session.use_strict_mode', '1');
ini_set('session.use_only_cookies', '1');
ini_set('session.cookie_secure', (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https' ? '1' : '0');
session_name('SPSESS'); session_start();
header('X-Content-Type-Options: nosniff'); header('X-Frame-Options: DENY'); header('Referrer-Policy: no-referrer');

function session_epoch(): void {
  if (!is_dir(DATA) && !mkdir(DATA, 0700, true)) throw new RuntimeException('Cannot create case storage.');
  $path = DATA . '/session.epoch';
  $f = fopen($path, 'c+');
  if (!$f || !flock($f, LOCK_EX)) throw new RuntimeException('Cannot lock session epoch.');
  try {
    chmod($path, 0600); $epoch = stream_get_contents($f);
    if ($epoch === '') { $epoch = bin2hex(random_bytes(32)); if (fwrite($f, $epoch) !== 64) throw new RuntimeException('Cannot create session epoch.'); }
    if (!is_string($epoch) || !preg_match('/^[a-f0-9]{64}$/D', $epoch)) throw new RuntimeException('Invalid session epoch.');
  } finally { fclose($f); }
  if (($_SESSION['epoch'] ?? null) !== $epoch) { $_SESSION = ['epoch' => $epoch]; }
}

function db(): PDO {
  static $p = null; if ($p) return $p;
  @mkdir(DATA . '/vault', 0700, true); @mkdir(DATA . '/tmp', 0700, true);
  $fresh = !file_exists(DATA . '/police.db');
  $p = new PDO('sqlite:' . DATA . '/police.db');
  $p->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  $p->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
  $p->exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
  $p->exec('PRAGMA busy_timeout=5000');
  if ($fresh) {
    $p->exec(file_get_contents(__DIR__ . '/../schema.sql'));
  }
  $p->exec('CREATE TABLE IF NOT EXISTS pdf_exports(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,case_id INTEGER,filename TEXT NOT NULL,vault TEXT NOT NULL,sha256 TEXT NOT NULL,created INTEGER NOT NULL)');
  $p->exec(file_get_contents(__DIR__ . '/requests-schema.sql'));
  if (!in_array('reviewer_id', $p->query('PRAGMA table_info(service_requests)')->fetchAll(PDO::FETCH_COLUMN, 1), true)) {
    $p->exec('ALTER TABLE service_requests ADD COLUMN reviewer_id INTEGER REFERENCES users(id)');
    $p->exec('UPDATE service_requests SET reviewer_id=officer_id WHERE reviewed_at IS NOT NULL');
  }
  if (!in_array('result_format', $p->query('PRAGMA table_info(service_requests)')->fetchAll(PDO::FETCH_COLUMN, 1), true)) {
    $p->exec("ALTER TABLE service_requests ADD COLUMN result_format TEXT NOT NULL DEFAULT 'review_record' CHECK(result_format IN('review_record','stamped_document'))");
  }
  $columns = $p->query('PRAGMA table_info(users)')->fetchAll(PDO::FETCH_COLUMN, 1);
  if (!in_array('approval_status', $columns, true)) $p->exec("ALTER TABLE users ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'active' CHECK(approval_status IN('active','pending','rejected'))");
  if (!in_array('email', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN email TEXT');
  if (!in_array('residential_address', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN residential_address TEXT');
  if (!in_array('phone', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN phone TEXT');
  if (!in_array('suspended', $columns, true)) $p->exec("ALTER TABLE users ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN(0,1))");
  if (!in_array('suspension_reason', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN suspension_reason TEXT');
  if (!in_array('suspended_at', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN suspended_at INTEGER');
  if (!in_array('suspended_by', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN suspended_by INTEGER REFERENCES users(id)');
  if (!in_array('review_flag_reason', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN review_flag_reason TEXT');
  if (!in_array('review_flagged_at', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN review_flagged_at INTEGER');
  if (!in_array('review_flagged_by', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN review_flagged_by INTEGER REFERENCES users(id)');
  if (!in_array('passkey_user_handle', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN passkey_user_handle TEXT');
  if (!in_array('passkey_credential', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN passkey_credential TEXT');
  if (!in_array('passkey_label', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN passkey_label TEXT');
  if (!in_array('passkey_created', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN passkey_created INTEGER');
  if (!in_array('passkey_last_used', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN passkey_last_used INTEGER');
  if (!in_array('admin_setup_hash', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN admin_setup_hash TEXT');
  if (!in_array('admin_setup_expires', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN admin_setup_expires INTEGER');
  if (!in_array('two_step_enabled', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN two_step_enabled INTEGER NOT NULL DEFAULT 0 CHECK(two_step_enabled IN(0,1))');
  if (!in_array('face_vault', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN face_vault TEXT');
  if (!in_array('face_sha256', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN face_sha256 TEXT');
  if (!in_array('face_mime', $columns, true)) $p->exec("ALTER TABLE users ADD COLUMN face_mime TEXT CHECK(face_mime IN('image/jpeg','image/png') OR face_mime IS NULL)");
  if (!in_array('face_updated', $columns, true)) $p->exec('ALTER TABLE users ADD COLUMN face_updated INTEGER');
  $emailIndex = $p->query("SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_users_email'")->fetchColumn();
  if (!$emailIndex || !str_contains(strtolower($emailIndex), 'lower(email)')) {
    $p->exec('DROP INDEX IF EXISTS ux_users_email');
    $p->exec("CREATE UNIQUE INDEX ux_users_email ON users(lower(email)) WHERE email IS NOT NULL AND email<>''");
  }
  if ((int)$p->query('PRAGMA user_version')->fetchColumn() < 1) {
    $p->exec("UPDATE users SET approval_status='active' WHERE role='citizen' AND approval_status='pending'");
    $p->exec('PRAGMA user_version=1');
  }
  return $p;
}
function master_key(): string {
  $f = DATA . '/master.key';
  if (!file_exists($f)) { file_put_contents($f, random_bytes(32)); chmod($f, 0600); }
  return file_get_contents($f);
}
// AES-256-GCM: file = iv(12) | tag(16) | ciphertext
function enc(string $d): string { $iv = random_bytes(12); $ct = openssl_encrypt($d, 'aes-256-gcm', master_key(), OPENSSL_RAW_DATA, $iv, $tag); return $iv . $tag . $ct; }
function dec(string $b): string { $r = openssl_decrypt(substr($b, 28), 'aes-256-gcm', master_key(), OPENSSL_RAW_DATA, substr($b, 0, 12), substr($b, 12, 16)); if ($r === false) throw new RuntimeException('Decrypt failed'); return $r; }
function vault_put(string $bytes): string { $n = bin2hex(random_bytes(16)) . '.enc'; file_put_contents(DATA . "/vault/$n", enc($bytes)); return $n; }
function vault_get(string $n): string { return dec(file_get_contents(DATA . '/vault/' . basename($n))); }

function out($d, int $code = 200): never { http_response_code($code); header('Content-Type: application/json'); echo json_encode($d); exit; }
function body(): array { $j = json_decode(file_get_contents('php://input') ?: '', true); return is_array($j) ? $j : $_POST; }
function coordinates(array $body, bool $optional = false): array {
  if ($optional && !isset($body['lat']) && !isset($body['lng'])) return [null, null];
  if (!isset($body['lat'], $body['lng']) || !is_numeric($body['lat']) || !is_numeric($body['lng'])) out(['error' => 'Valid latitude and longitude are required'], 400);
  $lat = (float)$body['lat']; $lng = (float)$body['lng'];
  if (!is_finite($lat) || !is_finite($lng) || abs($lat) > 90 || abs($lng) > 180) out(['error' => 'Bad coordinates'], 400);
  return [$lat, $lng];
}
function audit(string $action, string $detail = '', ?array $u = null): void {
  $u ??= me();
  db()->prepare('INSERT INTO audit(ts,user_id,username,action,detail,ip,ua) VALUES(?,?,?,?,?,?,?)')
    ->execute([time(), $u['id'] ?? null, $u['username'] ?? null, $action, $detail, $_SERVER['REMOTE_ADDR'] ?? '', substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 160)]);
}
function csrf_need(): void {
  if ($_SERVER['REQUEST_METHOD'] !== 'POST' || empty($_SESSION['csrf']) || !hash_equals($_SESSION['csrf'], $_SERVER['HTTP_X_CSRF'] ?? '')) {
    out(['error' => 'Security token expired. Reload this page and try again.'], 403);
  }
}
function me(): ?array {
  if (empty($_SESSION['uid'])) return null;
  $s = db()->prepare('SELECT id,username,name,role,pass_hash,approval_status,suspended,suspended_at,suspension_reason,passkey_credential,passkey_label,passkey_created,passkey_last_used,two_step_enabled,(face_vault IS NOT NULL) has_face_photo FROM users WHERE id=?'); $s->execute([$_SESSION['uid']]);
  $u = $s->fetch();
  if (!$u || $u['approval_status'] !== 'active') { unset($_SESSION['uid']); return null; }
  if ((int)$u['suspended'] === 1) {
    audit('access.suspended_' . $u['role'], (string)($u['suspension_reason'] ?? ''), $u);
    db()->prepare('DELETE FROM admin_lock WHERE session_id=?')->execute([session_id()]);
    unset($_SESSION['uid'], $_SESSION['credential_version'], $_SESSION['auth_started'], $_SESSION['last_activity']);
    session_regenerate_id(true);
    $_SESSION['csrf'] = bin2hex(random_bytes(16));
    return null;
  }
  $now = time();
  $_SESSION['auth_started'] ??= $now; $_SESSION['last_activity'] ??= $now;
  $version = hash('sha256', $u['pass_hash']);
  $_SESSION['credential_version'] ??= $version;
  if ($now - $_SESSION['auth_started'] > 43200 || $now - $_SESSION['last_activity'] > 1800 || !hash_equals($_SESSION['credential_version'], $version) ||
      (int)($_SESSION['suspension_version'] ?? 0) !== (int)$u['suspended_at'] ||
      (int)($_SESSION['two_step_policy'] ?? 0) !== (int)$u['two_step_enabled'] ||
      ((int)$u['two_step_enabled'] === 1 && empty($_SESSION['two_step_verified']))) {
    db()->prepare('DELETE FROM admin_lock WHERE session_id=?')->execute([session_id()]);
    unset($_SESSION['uid'], $_SESSION['credential_version'], $_SESSION['auth_started'], $_SESSION['last_activity']);
    return null;
  }
  $u['has_passkey'] = !empty($u['passkey_credential']);
  $u['two_step_enabled'] = (bool)$u['two_step_enabled'];
  $u['has_face_photo'] = (bool)$u['has_face_photo'];
  unset($u['pass_hash'], $u['approval_status'], $u['suspended'], $u['suspension_reason'], $u['passkey_credential']);
  return $u;
}
function signed_in(int $uid, string $hash, bool $twoStepVerified = false): void {
  session_regenerate_id(true);
  unset($_SESSION['two_step_pending'], $_SESSION['passkey_login'], $_SESSION['passkey_registration'], $_SESSION['passkey_two_step']);
  $_SESSION['uid'] = $uid; $_SESSION['csrf'] = bin2hex(random_bytes(16));
  $_SESSION['auth_started'] = $_SESSION['last_activity'] = time();
  $_SESSION['credential_version'] = hash('sha256', $hash);
  $policy = db()->prepare('SELECT two_step_enabled,suspended_at FROM users WHERE id=?');
  $policy->execute([$uid]);
  $policyRow = $policy->fetch();
  $_SESSION['two_step_policy'] = (int)$policyRow['two_step_enabled'];
  $_SESSION['suspension_version'] = (int)$policyRow['suspended_at'];
  $_SESSION['two_step_verified'] = $twoStepVerified;
}
function password_need(string $password): void {
  if (!mb_check_encoding($password, 'UTF-8') || mb_strlen($password, 'UTF-8') < 5 || mb_strlen($password, 'UTF-8') > 8 || str_contains($password, "\0")) out(['error' => 'Use a password of 5–8 characters, without null characters.'], 400);
}
function password_creation_need(string $password): void {
  password_need($password);
  if (preg_match('/\A0+\z/D', $password)) out(['error' => 'Weak Password. Choose a password that is not all zeroes.'], 400);
}
// Admin single-session lock: one live admin console; stale after 45s without a heartbeat.
function admin_claim(int $uid): bool {
  $d = db(); $r = $d->query('SELECT * FROM admin_lock WHERE id=1')->fetch();
  if ($r && $r['session_id'] !== session_id() && time() - (int)$r['last_seen'] < 45) return false;
  $d->prepare('INSERT OR REPLACE INTO admin_lock(id,session_id,user_id,last_seen) VALUES(1,?,?,?)')->execute([session_id(), $uid, time()]);
  return true;
}
function need(array $roles): array {
  $u = me();
  if (!$u) out(['error' => 'Please sign in'], 401);
  if ($u['role'] === 'admin' && !admin_claim((int)$u['id'])) { audit('admin.session_displaced', '', $u); unset($_SESSION['uid']); out(['error' => 'The admin console is now open in another session', 'code' => 'SESSION_DISPLACED'], 409); }
  if (!in_array($u['role'], $roles, true)) { audit('access.denied', $_GET['a'] ?? '', $u); out(['error' => 'Not allowed for your role'], 403); }
  if ($_SERVER['REQUEST_METHOD'] === 'POST') csrf_need();
  if (!in_array($_GET['a'] ?? '', ['state', 'csrf'], true)) $_SESSION['last_activity'] = time();
  return $u;
}
function event(int $cid, string $text, string $by): void {
  $d = db(); $d->prepare('INSERT INTO case_events(case_id,text,by_name,ts) VALUES(?,?,?,?)')->execute([$cid, $text, $by, time()]);
  $d->prepare('UPDATE cases SET updated=? WHERE id=?')->execute([time(), $cid]);
}
function case_for(array $u, int $cid): ?array {
  $s = db()->prepare('SELECT * FROM cases WHERE id=?'); $s->execute([$cid]); $c = $s->fetch();
  if (!$c) return null;
  if ($u['role'] === 'admin') return $c;
  if ($u['role'] === 'citizen') return (int)$c['citizen_id'] === (int)$u['id'] ? $c : null;
  return ($c['officer_id'] === null || (int)$c['officer_id'] === (int)$u['id']) ? $c : null;
}

// Builds the certified PDF. Prefers the compiled C++ stamper; falls back to an equivalent PHP writer
// if the binary is missing, so certification still works on a machine without a C++ compiler.
function stamp_pdf(string $in, string $out, array $a): string {
  [$ref, $off, $date, $sha] = $a;
  $bin = __DIR__ . '/../bin/stamper' . (PHP_OS_FAMILY === 'Windows' ? '.exe' : '');
  if (is_file($bin)) {
    $cmd = implode(' ', array_map('escapeshellarg', [$bin, $in, $out, $ref, $off, $date, $sha]));
    exec($cmd, $o, $rc); if ($rc === 0 && is_file($out)) return 'c++';
  }
  $e = fn($s) => preg_replace('/[^\x20-\x7e]/', '?', str_replace(['\\', '(', ')'], ['\\\\', '\\(', '\\)'], $s));
  $L = []; foreach (preg_split('/\r?\n/', file_get_contents($in)) as $l) foreach (explode("\n", wordwrap($l, 88, "\n", true)) as $w) $L[] = $w;
  $per = 42; $n = max(1, (int)ceil(count($L) / $per)); $o = "%PDF-1.4\n"; $offs = [];
  $add = function ($b) use (&$o, &$offs) { $offs[] = strlen($o); $o .= count($offs) . " 0 obj\n$b\nendobj\n"; };
  $kids = ''; for ($i = 0; $i < $n; $i++) $kids .= (5 + 2 * $i) . ' 0 R ';
  $add('<< /Type /Catalog /Pages 2 0 R >>'); $add("<< /Type /Pages /Kids [$kids] /Count $n >>");
  $add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); $add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  for ($i = 0; $i < $n; $i++) {
    $c = 'BT /F2 14 Tf 50 800 Td (SWORN AFFIDAVIT - CASE ' . $e($ref) . ") Tj ET\nBT /F1 10 Tf 14 TL 50 770 Td\n";
    foreach (array_slice($L, $i * $per, $per) as $l) $c .= '(' . $e($l) . ") Tj T*\n";
    $c .= "ET\nBT /F1 8 Tf 50 30 Td (Page " . ($i + 1) . " of $n) Tj ET\n";
    if ($i === $n - 1) {
      $c .= "0.78 0.2 0.12 RG 0.78 0.2 0.12 rg 2 w 50 62 m 360 62 l 360 150 l 50 150 l h S\nBT /F2 15 Tf 62 130 Td (CERTIFIED TRUE COPY) Tj ET\n";
      $c .= 'BT /F1 9 Tf 12 TL 62 112 Td (Certified by: ' . $e($off) . ') Tj T* (Date: ' . $e($date) . ') Tj T* (Case: ' . $e($ref) . ') Tj T* (SHA-256: ' . substr($sha, 0, 32) . ') Tj T* (' . substr($sha, 32) . ") Tj ET\n";
    }
    $add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' . (6 + 2 * $i) . ' 0 R >>');
    $add('<< /Length ' . strlen($c) . " >>\nstream\n{$c}endstream");
  }
  $xr = strlen($o); $o .= 'xref' . "\n0 " . (count($offs) + 1) . "\n0000000000 65535 f \n";
  foreach ($offs as $f) $o .= sprintf("%010d 00000 n \n", $f);
  $o .= 'trailer' . "\n<< /Size " . (count($offs) + 1) . " /Root 1 0 R >>\nstartxref\n$xr\n%%EOF\n";
  return file_put_contents($out, $o) ? 'php' : '';
}
