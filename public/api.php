<?php
declare(strict_types=1);
require __DIR__ . '/../src/lib.php';
require __DIR__ . '/../src/pdf.php';
require __DIR__ . '/../src/backup.php';
require __DIR__ . '/../src/reports.php';
require __DIR__ . '/../src/passkeys.php';
require __DIR__ . '/../src/requests.php';
require __DIR__ . '/../src/request-stamp.php';
require __DIR__ . '/../src/registration-roster.php';
require __DIR__ . '/../src/admin-setup.php';
require __DIR__ . '/../src/document-preview.php';
require __DIR__ . '/../src/phone-otp.php';
$a = $_GET['a'] ?? '';
// Coordinate every read/write with backup and offline recovery, including uploads.
$storageLock = backup_lock(rtrim(DATA, '/'), $a === 'backup_archive');
session_epoch();
$d = db();
registration_roster_track_api_changes($d);
if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 44 * 1024 * 1024) out(['error'=>'The upload exceeds the 44 MB request limit. Each file must be 10 MB or smaller.'],413);
$b = body();
header('Cache-Control: no-store');
if (!in_array($a, ['csrf', 'state', 'download', 'request_download', 'request_face_preview', 'user_face_preview', 'pdf_export_download', 'report_csv', 'operational_report', 'case_pdf', 'backup_pdf', 'settings_pdf'], true) && $_SERVER['REQUEST_METHOD'] !== 'POST') {
  out(['error' => 'Use POST for this action'], 405);
}
const STATUSES = ['Assigned', 'Evidence Collection', 'Closed'];
const MAXFILE = 10 * 1024 * 1024;
function str(array $b, string $k, int $max): string {
  if (isset($b[$k]) && !is_string($b[$k])) out(['error' => "Enter text for $k"], 400);
  $value = trim($b[$k] ?? '');
  if (!mb_check_encoding($value, 'UTF-8') || mb_strlen($value) > $max) out(['error' => "$k must be at most $max characters"], 400);
  return $value;
}
function username_value(array $payload): string {
  $username = str($payload, 'username', 80);
  if ($username === '' || preg_match('/\p{Cc}/u', $username)) out(['error' => 'Enter a username of 1–80 characters without control characters.'], 400);
  return $username;
}
function password_value(array $payload, string $field = 'password'): string {
  if (!array_key_exists($field, $payload) || !is_string($payload[$field])) out(['error' => 'Enter a password'], 400);
  return $payload[$field];
}
function admin_email_value(array $payload): string {
  $email = strtolower(str($payload, 'email', 254));
  if (!filter_var($email, FILTER_VALIDATE_EMAIL) || !str_ends_with($email, '@admin.co.za')) out(['error' => 'Enter a valid email address ending in @admin.co.za.'], 400);
  $check = db()->prepare('SELECT 1 FROM users WHERE lower(email)=?'); $check->execute([$email]);
  if ($check->fetchColumn()) out(['error' => 'That administrator email is already in use.'], 409);
  return $email;
}
function citizen_email_value(array $payload): string {
  $email = strtolower(str($payload, 'email', 254));
  if (!filter_var($email, FILTER_VALIDATE_EMAIL) || !str_ends_with($email, '@gmail.com')) out(['error' => 'Enter a valid email address ending in @gmail.com.'], 400);
  $check = db()->prepare('SELECT 1 FROM users WHERE lower(email)=?'); $check->execute([$email]);
  if ($check->fetchColumn()) out(['error' => 'That email address is already in use.'], 409);
  return $email;
}
function citizen_contact_values(array $payload): array {
  $address = str($payload, 'residential_address', 240);
  if (mb_strlen($address) < 5 || preg_match('/\p{Cc}/u', $address)) out(['error' => 'Enter a residential address of at least 5 characters.'], 400);
  $phone = str($payload, 'phone', 9);
  if (!preg_match('/^[1-9][0-9]{8}$/D', $phone)) out(['error' => 'Enter the 9-digit South African number after +27.'], 400);
  return [$address, '+27' . $phone];
}
function upload(): array {
  $f = $_FILES['file'] ?? null;
  if (!$f || $f['error'] !== UPLOAD_ERR_OK) out(['error' => 'Choose a file to upload'], 400);
  if ($f['size'] > MAXFILE) out(['error' => 'File is larger than 10 MB'], 400);
  return [file_get_contents($f['tmp_name']), basename($f['name']), (int)$f['size']];
}

try { switch ($a) {
case 'phone_otp_send':
case 'phone_otp_verify':
  phone_otp_demo($d, $a, $b);

case 'register': {
  csrf_need();
  if (!(int)$d->query("SELECT COUNT(*) FROM users WHERE role='admin' AND approval_status='active'")->fetchColumn()) out(['error' => 'An administrator must complete initial setup first'], 409);
  $n = str($b, 'name', 80); $un = username_value($b); $pw = password_value($b);
  $role = str($b, 'role', 20) ?: 'citizen';
  if (!in_array($role, ['citizen', 'officer', 'admin'], true)) out(['error' => 'Choose the Citizen, Officer or Admin signup portal'], 400);
  $email = $address = $phone = null;
  if ($role === 'admin') $email = admin_email_value($b);
  if ($role === 'citizen') {
    $email = citizen_email_value($b);
    [$address, $phone] = citizen_contact_values($b);
  }
  if ($role === 'citizen') {
    if (($b['face_consent'] ?? '') !== 'yes') out(['error'=>'Confirm that your camera photo can be stored securely and viewed by Admins and assigned Officers for human review.'],400);
    if (array_diff(array_keys($_FILES), ['selfie'])) out(['error'=>'Unexpected signup attachment.'],400);
    $facePhoto = request_upload('selfie', true);
  } else {
    if ($_FILES) out(['error'=>'Unexpected signup attachment.'],400);
    $facePhoto = null;
  }
  if (strlen($n) < 2 || $pw === '') out(['error' => 'Enter your name and password'], 400);
  password_creation_need($pw);
  if ($d->query('SELECT 1 FROM users WHERE username=' . $d->quote($un))->fetch()) out(['error' => 'That username is taken'], 409);
  $setupCitizenPasskey = $role === 'citizen' && ($b['passkey_enroll'] ?? false) === true;
  if ($setupCitizenPasskey && !empty($_SESSION['uid'])) out(['error' => 'Sign out of the current account before creating a Citizen account with a passkey.'], 409);
  $approval = $role === 'citizen' ? 'active' : 'pending';
  $passwordHash = password_hash($pw, PASSWORD_DEFAULT);
  $createdPhoto = null;
  $createdPhotoFiles = [];
  $d->beginTransaction();
  try {
    $d->prepare('INSERT INTO users(username,name,role,pass_hash,created,approval_status,email,residential_address,phone) VALUES(?,?,?,?,?,?,?,?,?)')->execute([$un, $n, $role, $passwordHash, time(), $approval, $email, $address, $phone]);
    $newUserId = (int)$d->lastInsertId();
    if ($facePhoto !== null) {
      $createdPhoto = request_store($facePhoto['bytes'], $createdPhotoFiles);
      $d->prepare('UPDATE users SET face_vault=?,face_sha256=?,face_mime=?,face_updated=? WHERE id=?')
        ->execute([$createdPhoto, $facePhoto['sha256'], $facePhoto['mime'], time(), $newUserId]);
    }
    $auditDetail = "$role | $approval";
    if ($facePhoto !== null) $auditDetail .= ' | camera-photo consent recorded';
    audit('user.register', $auditDetail, ['id' => $newUserId, 'username' => $un]);
    $d->commit();
  } catch (Throwable $error) {
    if ($d->inTransaction()) $d->rollBack();
    foreach ($createdPhotoFiles as $vault) @unlink(DATA . '/vault/' . $vault);
    if ($createdPhoto && !in_array($createdPhoto, $createdPhotoFiles, true)) @unlink(DATA . '/vault/' . $createdPhoto);
    throw $error;
  }
  if ($setupCitizenPasskey) {
    signed_in($newUserId, $passwordHash);
    out(['ok' => 1, 'approval_status' => $approval, 'passkey_setup' => true, 'csrf' => $_SESSION['csrf']]);
  }
  out(['ok' => 1, 'approval_status' => $approval, 'message' => $role === 'citizen' ? 'Citizen account created. You can sign in now.' : 'Signup submitted. An administrator must approve the account before sign-in.']);
}
case 'login': {
  csrf_need();
  unset($_SESSION['two_step_pending'], $_SESSION['passkey_login']);
  $un = username_value($b); $pw = password_value($b);
  password_need($pw);
  $f = $d->prepare('SELECT COUNT(*) FROM audit WHERE action="login.fail" AND username=? AND ts>?'); $f->execute([$un, time() - 600]);
  if ($f->fetchColumn() >= 5) out(['error' => 'Too many failed attempts. Try again in 10 minutes'], 429);
  $s = $d->prepare('SELECT * FROM users WHERE username=?'); $s->execute([$un]); $u = $s->fetch();
  if (!$u || strlen($pw) > 1024 || !password_verify($pw, $u['pass_hash'])) { audit('login.fail', '', ['username' => $un]); out(['error' => 'Wrong username or password'], 401); }
  if (!empty($b['role']) && $b['role'] !== $u['role']) out(['error' => 'This account belongs to the ' . $u['role'] . ' portal. Choose that portal to sign in.'], 403);
  if ($u['approval_status'] !== 'active') {
    audit('login.not_approved', $u['approval_status'], $u);
    out(['error' => $u['approval_status'] === 'pending' ? 'Your account is awaiting administrator approval. Please try again after it has been approved.' : 'Your signup request was rejected. Contact your administrator.'], 403);
  }
  if ((int)$u['suspended'] === 1) {
    audit('login.suspended_' . $u['role'], (string)($u['suspension_reason'] ?? ''), $u);
    out(['error' => 'Your ' . ucfirst($u['role']) . ' account is suspended. Reason: ' . ($u['suspension_reason'] ?: 'Contact an administrator for details.')], 403);
  }
  if ($u['role'] === 'citizen') {
    if (array_diff(array_keys($_FILES), ['login_capture'])) out(['error'=>'Unexpected sign-in attachment.'],400);
    // Capture gate only, never a biometric verification result. Do not persist the frame.
    $loginPhoto = request_upload('login_capture', true);
    unset($loginPhoto);
  }
  if (password_needs_rehash($u['pass_hash'], PASSWORD_DEFAULT)) {
    $u['pass_hash'] = password_hash($pw, PASSWORD_DEFAULT);
    $d->prepare('UPDATE users SET pass_hash=? WHERE id=?')->execute([$u['pass_hash'], $u['id']]);
  }
  if ($u['role'] === 'citizen' && (int)$u['two_step_enabled'] === 1) {
    if (!$u['passkey_credential']) out(['error' => 'Two-step verification needs your registered passkey. Contact an administrator if your passkey is lost.'], 403);
    unset($_SESSION['uid'], $_SESSION['credential_version'], $_SESSION['auth_started'], $_SESSION['last_activity'], $_SESSION['passkey_registration'], $_SESSION['passkey_two_step']);
    session_regenerate_id(true);
    $_SESSION['csrf'] = bin2hex(random_bytes(16));
    $_SESSION['two_step_pending'] = ['user_id' => (int)$u['id'], 'issued' => time(), 'version' => passkey_account_version($u)];
    out(['two_step_required' => true, 'csrf' => $_SESSION['csrf']]);
  }
  signed_in((int)$u['id'], $u['pass_hash']);
  if ($u['role'] === 'admin' && !admin_claim((int)$u['id'])) { unset($_SESSION['uid']); audit('login.blocked', 'admin console already open', $u); out(['error' => 'The admin console is already open in another session. Close it or wait 45 seconds', 'csrf' => $_SESSION['csrf']], 409); }
  audit('login.ok', $u['role'], $u); out(['csrf' => $_SESSION['csrf']]);
}
case 'passkey_register_options': passkey_register_options($d, $b);
case 'passkey_register_verify': passkey_register_verify($d);
case 'passkey_login_options': passkey_login_options($d, $b);
case 'passkey_login_verify': passkey_login_verify($d);
case 'passkey_two_step_options': passkey_two_step_options($d, $b);
case 'passkey_two_step_verify': passkey_two_step_verify($d);
case 'logout': {
  csrf_need();
  $u = me(); if ($u) { audit('logout', '', $u); if ($u['role'] === 'admin') $d->prepare('DELETE FROM admin_lock WHERE session_id=?')->execute([session_id()]); }
  $_SESSION = []; session_destroy(); out(['ok' => 1]);
}

case 'state': {
  $u = need(['citizen', 'officer', 'admin']); $id = (int)$u['id'];
  $w = ['citizen' => "c.citizen_id=$id", 'officer' => "(c.officer_id=$id OR c.officer_id IS NULL)", 'admin' => '1'][$u['role']];
   $cases = $d->query("SELECT c.*,cu.name citizen_name,cu.email citizen_email,cu.phone citizen_phone,cu.residential_address citizen_address,ou.name officer_name FROM cases c JOIN users cu ON cu.id=c.citizen_id LEFT JOIN users ou ON ou.id=c.officer_id WHERE $w ORDER BY c.updated DESC LIMIT 200")->fetchAll();
  foreach ($cases as &$c) {
    $cid = (int)$c['id'];
    $c['events'] = $d->query("SELECT text,by_name,ts FROM case_events WHERE case_id=$cid ORDER BY id")->fetchAll();
    $c['evidence'] = $d->query("SELECT id,filename,size,status,note,created FROM evidence WHERE case_id=$cid ORDER BY id")->fetchAll();
    $c['affidavits'] = $d->query("SELECT id,status,created,certified_at,sha256 FROM affidavits WHERE case_id=$cid ORDER BY id")->fetchAll();
  } unset($c);
  $sw = $u['role'] === 'citizen' ? "WHERE s.citizen_id=$id" : '';
  $st = ['me' => $u, 'cases' => $cases, 'now' => time(),
    'sos' => $d->query("SELECT s.*,u.name citizen_name FROM sos s JOIN users u ON u.id=s.citizen_id $sw ORDER BY s.id DESC LIMIT 30")->fetchAll()];
   if ($u['role'] !== 'citizen') $st['officers'] = $d->query("SELECT id,name FROM users WHERE role='officer' AND approval_status='active' AND suspended=0 ORDER BY name")->fetchAll();
  $st['requests'] = requests_state($d, $u);
  if ($u['role'] === 'citizen') $st['citizenStats'] = requests_citizen_stats($d, $id);
  if ($u['role'] === 'admin') {
    $st['stats'] = ['status' => $d->query('SELECT status k,COUNT(*) n FROM cases GROUP BY status')->fetchAll(),
      'type' => $d->query('SELECT type k,COUNT(*) n FROM cases GROUP BY type')->fetchAll(),
      'pendingEvidence' => (int)$d->query("SELECT COUNT(*) FROM evidence WHERE status='Pending'")->fetchColumn(),
      'pendingAffidavits' => (int)$d->query("SELECT COUNT(*) FROM affidavits WHERE status='Pending'")->fetchColumn(),
      'totalCases' => (int)$d->query('SELECT COUNT(*) FROM cases')->fetchColumn(),
      'totalEvidence' => (int)$d->query('SELECT COUNT(*) FROM evidence')->fetchColumn(),
      'activeCitizens' => (int)$d->query("SELECT COUNT(*) FROM users WHERE role='citizen' AND approval_status='active' AND suspended=0")->fetchColumn(),
       'activeOfficers' => (int)$d->query("SELECT COUNT(*) FROM users WHERE role='officer' AND approval_status='active' AND suspended=0")->fetchColumn(),
      'activeAdmins' => (int)$d->query("SELECT COUNT(*) FROM users WHERE role='admin' AND approval_status='active' AND suspended=0 AND admin_setup_hash IS NULL")->fetchColumn(),
      'pendingAccounts' => (int)$d->query("SELECT COUNT(*) FROM users WHERE approval_status='pending'")->fetchColumn(),
       'flaggedCitizenAccounts' => (int)$d->query("SELECT COUNT(*) FROM users WHERE role='citizen' AND review_flag_reason IS NOT NULL")->fetchColumn(),
      'unassignedCases' => (int)$d->query("SELECT COUNT(*) FROM cases WHERE officer_id IS NULL AND status!='Closed'")->fetchColumn(),
      'activeSos' => (int)$d->query("SELECT COUNT(*) FROM sos WHERE status IN ('Open','Responding')")->fetchColumn()];
     $st['users'] = $d->query('SELECT u.id,u.username,u.name,u.role,u.created,u.approval_status,u.email,u.residential_address,u.phone,u.suspended,u.suspension_reason,u.suspended_at,u.review_flag_reason,u.review_flagged_at,u.passkey_label,u.passkey_created,u.passkey_last_used,(u.face_vault IS NOT NULL) face_photo_available,(u.admin_setup_hash IS NOT NULL) setup_pending,u.admin_setup_expires setup_expires_at,s.name suspended_by_name,f.name review_flagged_by_name FROM users u LEFT JOIN users s ON s.id=u.suspended_by LEFT JOIN users f ON f.id=u.review_flagged_by ORDER BY u.id')->fetchAll();
    $st['audit'] = $d->query('SELECT * FROM audit ORDER BY id DESC LIMIT 150')->fetchAll();
    $st['pdfExports'] = $d->query('SELECT p.id,p.case_id,p.filename,p.sha256,p.created,u.name created_by FROM pdf_exports p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 50')->fetchAll();
    $st['registrationRoster'] = registration_roster_status();
  }
  out($st);
}
case 'registration_roster_sync': {
  need(['admin']);
  $status = registration_roster_sync($d);
  if (!$status['synced']) out(['error' => $status['error'] ?: 'OneDrive database workbook could not be updated.', 'registrationRoster' => $status], 502);
  out(['ok' => 1, 'registrationRoster' => $status]);
}
case 'request_create': request_create($d, $b);
case 'request_claim': request_claim($d, $b);
case 'request_review': request_review($d, $b);
case 'citizen_flag': {
  $officer = need(['officer']);
  $request = request_find($d, (int)($b['request_id'] ?? 0));
  if ((int)$request['officer_id'] !== (int)$officer['id']) out(['error'=>'Only the Officer assigned to this service request can flag its Citizen account.'],403);
  $reason = str($b, 'reason', 500);
  if (mb_strlen($reason) < 10 || preg_match('/\p{Cc}/u', $reason)) out(['error'=>'Enter a clear account-review reason of 10–500 characters.'],400);
  $q = $d->prepare("UPDATE users SET review_flag_reason=?,review_flagged_at=?,review_flagged_by=? WHERE id=? AND role='citizen'");
  $q->execute([$reason,time(),$officer['id'],$request['citizen_id']]);
  if (!$q->rowCount()) out(['error'=>'Citizen account could not be flagged.'],404);
  audit('citizen.flagged_for_admin_review', $request['ref'] . ': ' . $reason, $officer);
  out(['ok'=>1]);
}
case 'citizen_flag_clear': {
  $admin = need(['admin']);
  $id = (int)($b['id'] ?? 0);
  $q=$d->prepare("UPDATE users SET review_flag_reason=NULL,review_flagged_at=NULL,review_flagged_by=NULL WHERE id=? AND role='citizen' AND review_flag_reason IS NOT NULL");
  $q->execute([$id]);
  if (!$q->rowCount()) out(['error'=>'No active review flag was found for this Citizen.'],409);
  audit('citizen.review_flag_cleared', 'Citizen account #' . $id, $admin);
  out(['ok'=>1]);
}
case 'request_download': request_download($d);
case 'request_face_preview': request_face_preview($d);
case 'face_photo_update': citizen_face_update($d, $b);
case 'user_face_preview': {
  $u = need(['admin']);
  $q = $d->prepare("SELECT id,face_vault,face_sha256,face_mime FROM users WHERE id=? AND role='citizen'");
  $q->execute([(int)($_GET['id'] ?? 0)]);
  $photo = $q->fetch();
  if (!$photo || !$photo['face_vault']) out(['error'=>'Citizen camera photo is not available.'],404);
  $bytes = vault_get($photo['face_vault']);
  if (!hash_equals($photo['face_sha256'], hash('sha256', $bytes))) throw new RuntimeException('Citizen camera photo integrity check failed.');
  $name = 'citizen-camera-photo.' . ($photo['face_mime'] === 'image/png' ? 'png' : 'jpg');
  audit('user.face_view', 'Citizen account ' . (int)$photo['id'], $u);
  if (($_GET['preview'] ?? '') === '1') document_preview($u, $bytes, $name, $photo['face_mime']);
  header('Content-Type: ' . $photo['face_mime']);
  header('Content-Disposition: attachment; filename="' . $name . '"');
  header('Cache-Control: private, no-store');
  header('X-Content-Type-Options: nosniff');
  header('Content-Length: ' . strlen($bytes));
  echo $bytes; exit;
}

case 'password_change': {
  $u = need(['citizen', 'officer', 'admin']); $new = password_value($b, 'new');
  $h = $d->query('SELECT pass_hash FROM users WHERE id=' . (int)$u['id'])->fetchColumn();
  if (!password_verify(password_value($b, 'old'), $h)) { audit('password.change_failed'); out(['error' => 'Current password is incorrect'], 400); }
  password_need($new);
  if (password_verify($new, $h)) out(['error' => 'Choose a password different from your current password'], 400);
  $hash = password_hash($new, PASSWORD_DEFAULT);
  $d->prepare('UPDATE users SET pass_hash=? WHERE id=?')->execute([$hash, $u['id']]);
  if ($u['role'] === 'admin') $d->prepare('DELETE FROM admin_lock WHERE session_id=?')->execute([session_id()]);
  signed_in((int)$u['id'], $hash);
  if ($u['role'] === 'admin') admin_claim((int)$u['id']);
  audit('password.change'); out(['ok' => 1, 'csrf' => $_SESSION['csrf']]);
}
case 'csrf': { if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(16)); $u = me(); out(['me' => $u, 'csrf' => $_SESSION['csrf'], 'setup' => !$u && !(int)$d->query('SELECT COUNT(*) FROM users')->fetchColumn()]); }
case 'setup': {   // first run only: the person who opens the app creates the administrator with a password of their choice
  csrf_need();
  $n = str($b, 'name', 80); $un = username_value($b); $pw = password_value($b);
  if (strlen($n) < 2 || $pw === '') out(['error' => 'Enter your name and password'], 400);
  password_creation_need($pw);
  $email = admin_email_value($b);
  $st = $d->prepare("INSERT INTO users(username,name,role,pass_hash,created,email) SELECT ?,?,'admin',?,?,? WHERE NOT EXISTS (SELECT 1 FROM users)");
  $hash = password_hash($pw, PASSWORD_DEFAULT);
  $st->execute([$un, $n, $hash, time(), $email]);
  if (!$st->rowCount()) out(['error' => 'Setup is already complete. Please sign in'], 409);
  $uid = (int)$d->lastInsertId(); signed_in($uid, $hash); admin_claim($uid);
  audit('setup.admin_created', $un, ['id' => $uid, 'username' => $un]); out(['csrf' => $_SESSION['csrf']]);
}

case 'report': {
  $u = need(['citizen']);
  $t = str($b, 'title', 120); $ty = str($b, 'type', 30); $ds = str($b, 'description', 4000); $lo = str($b, 'location', 200);
  if (mb_strlen($t) < 3 || mb_strlen($ds) < 10 || !in_array($ty, ['Theft', 'Assault', 'Fraud', 'Vandalism', 'Traffic accident', 'Suspicious activity', 'Other'], true)) out(['error' => 'Add a title of at least 3 characters, a description of at least 10 characters, and choose a valid incident type'], 400);
  $d->prepare('INSERT INTO cases(citizen_id,title,type,description,location,created,updated) VALUES(?,?,?,?,?,?,?)')->execute([$u['id'], $t, $ty, $ds, $lo, time(), time()]);
  $cid = (int)$d->lastInsertId(); $ref = sprintf('SP-%s-%05d', date('y'), $cid);
  $d->prepare('UPDATE cases SET ref=? WHERE id=?')->execute([$ref, $cid]);
  event($cid, 'Incident reported', $u['name']); audit('case.report', $ref); out(['ref' => $ref]);
}
case 'assign': {
  $u = need(['officer', 'admin']); $c = case_for($u, (int)($b['case_id'] ?? 0));
  if (!$c || $c['status'] === 'Closed') out(['error' => 'Case not available'], 404);
  $oid = $u['role'] === 'officer' ? (int)$u['id'] : (int)($b['officer_id'] ?? 0);
  if ($u['role'] === 'officer' && $c['officer_id'] !== null) out(['error' => 'Already assigned'], 409);
  $o = $d->query("SELECT name FROM users WHERE role='officer' AND approval_status='active' AND suspended=0 AND id=$oid")->fetch(); if (!$o) out(['error' => 'Choose an active, approved Officer'], 400);
  $d->prepare("UPDATE cases SET officer_id=?,status=CASE WHEN status='Reported' THEN 'Assigned' ELSE status END WHERE id=?")->execute([$oid, $c['id']]);
  event((int)$c['id'], 'Assigned to ' . $o['name'], $u['name']); audit('case.assign', $c['ref'] . ' -> ' . $o['name']); out(['ok' => 1]);
}
case 'status': {
  $u = need(['officer', 'admin']); $c = case_for($u, (int)($b['case_id'] ?? 0)); $s = (string)($b['status'] ?? '');
  if (!$c || $c['officer_id'] === null || !in_array($s, STATUSES, true)) out(['error' => 'Assign the case to an officer first'], 400);
  if ($s === 'Closed' && $d->query("SELECT 1 FROM evidence WHERE case_id={$c['id']} AND status='Pending'")->fetch()) out(['error' => 'Review all pending evidence before closing'], 409);
  $d->prepare('UPDATE cases SET status=? WHERE id=?')->execute([$s, $c['id']]);
  event((int)$c['id'], "Status changed to $s", $u['name']); audit('case.status', $c['ref'] . " $s"); out(['ok' => 1]);
}

case 'evidence_upload': {
  $u = need(['citizen', 'officer', 'admin']); $c = case_for($u, (int)($_POST['case_id'] ?? 0));
  if (!$c || $c['status'] === 'Closed') out(['error' => 'Case not available'], 404);
  [$bytes, $name, $size] = upload();
  $d->prepare('INSERT INTO evidence(case_id,uploader_id,filename,size,vault,created) VALUES(?,?,?,?,?,?)')->execute([$c['id'], $u['id'], $name, $size, vault_put($bytes), time()]);
  event((int)$c['id'], "Evidence uploaded: $name (awaiting review)", $u['name']); audit('evidence.upload', $c['ref'] . ' ' . $name); out(['ok' => 1]);
}
case 'evidence_review': {
  $u = need(['officer', 'admin']); $e = $d->query('SELECT * FROM evidence WHERE id=' . (int)($b['id'] ?? 0))->fetch();
  $c = $e ? case_for($u, (int)$e['case_id']) : null; $s = (string)($b['status'] ?? ''); $note = str($b, 'note', 500);
  if (!$c || !in_array($s, ['Approved', 'Rejected'], true)) out(['error' => 'Evidence not found'], 404);
  if ($s === 'Rejected' && !$note) out(['error' => 'Add a note explaining the rejection'], 400);
  $d->prepare('UPDATE evidence SET status=?,note=?,reviewer_id=? WHERE id=?')->execute([$s, $note, $u['id'], $e['id']]);
  event((int)$c['id'], "Evidence {$e['filename']} $s" . ($note ? ": $note" : ''), $u['name']); audit('evidence.' . strtolower($s), $c['ref'] . ' ' . $e['filename']); out(['ok' => 1]);
}

case 'affidavit_upload': {
  $u = need(['citizen']); $c = case_for($u, (int)($_POST['case_id'] ?? 0));
  if (!$c || $c['status'] === 'Closed') out(['error' => 'Case not available'], 404);
  $txt = trim((string)($_POST['text'] ?? ''));
  if (!$txt && !empty($_FILES['file']['tmp_name'])) { [$txt] = upload(); }
  if (strlen($txt) < 20 || strlen($txt) > 40000 || !mb_check_encoding($txt, 'UTF-8')) out(['error' => 'Affidavit must be 20 to 40,000 characters of plain text'], 400);
  $d->prepare('INSERT INTO affidavits(case_id,citizen_id,vault,sha256,created) VALUES(?,?,?,?,?)')->execute([$c['id'], $u['id'], vault_put($txt), hash('sha256', $txt), time()]);
  event((int)$c['id'], 'Affidavit submitted for certification', $u['name']); audit('affidavit.upload', $c['ref']); out(['ok' => 1]);
}
case 'affidavit_certify': {
  $u = need(['officer']); $af = $d->query('SELECT * FROM affidavits WHERE id=' . (int)($b['id'] ?? 0))->fetch();
  $c = $af ? case_for($u, (int)$af['case_id']) : null;
  if (!$c || $af['status'] !== 'Pending' || (int)$c['officer_id'] !== (int)$u['id']) out(['error' => 'Take the case before certifying its affidavit'], 409);
  $in = DATA . '/tmp/' . bin2hex(random_bytes(8)); $pdf = $in . '.pdf';
  file_put_contents($in, vault_get($af['vault']));
  $certifiedAt = time();
  $how = stamp_pdf($in, $pdf, [$c['ref'], $u['name'], date('Y-m-d H:i:s T (P)', $certifiedAt), $af['sha256']]); @unlink($in);
  if (!$how) { audit('affidavit.stamp_failed'); out(['error' => 'Stamping failed'], 500); }
  $sv = vault_put(file_get_contents($pdf)); @unlink($pdf);
  $d->prepare("UPDATE affidavits SET status='Certified',stamped_vault=?,officer_id=?,certified_at=? WHERE id=?")->execute([$sv, $u['id'], $certifiedAt, $af['id']]);
  event((int)$c['id'], 'Affidavit certified and stamped', $u['name']); audit('affidavit.certify', $c['ref'] . " ($how)"); out(['ok' => 1]);
}

case 'pdf_export_download': {
  $u = need(['admin']); $id = (int)($_GET['id'] ?? 0);
  $statement = $d->prepare('SELECT filename,vault FROM pdf_exports WHERE id=?'); $statement->execute([$id]); $export = $statement->fetch();
  if (!$export) out(['error' => 'Saved PDF not found'], 404);
  $bytes = vault_get($export['vault']);
  audit('pdf.download', $export['filename'], $u);
  header('Content-Type: application/pdf');
  header('Content-Disposition: attachment; filename="' . preg_replace('/[^\w.\-]/', '_', $export['filename']) . '"');
  header('Content-Length: ' . strlen($bytes)); echo $bytes; exit;
}
case 'download': {
  $preview = ($_GET['preview'] ?? '') === '1';
  $u = need($preview ? ['officer','admin'] : ['citizen', 'officer', 'admin']); $id = (int)($_GET['id'] ?? 0);
  $previewMime = null;
  if (($_GET['t'] ?? '') === 'evidence') {
    $r = $d->query("SELECT * FROM evidence WHERE id=$id")->fetch(); $c = $r ? case_for($u, (int)$r['case_id']) : null;
    if (!$c) out(['error' => 'Not found'], 404);
    $data = vault_get($r['vault']); $name = $r['filename']; audit($preview ? 'evidence.view' : 'evidence.download', $c['ref'] . ' ' . $name);
  } else {
    $r = $d->query("SELECT * FROM affidavits WHERE id=$id")->fetch(); $c = $r ? case_for($u, (int)$r['case_id']) : null;
    if (!$c || ($r['status'] !== 'Certified' && $u['role'] === 'citizen')) out(['error' => 'Not available until certified'], 404);
    $data = vault_get($r['stamped_vault'] ?: $r['vault']); $name = $r['stamped_vault'] ? "affidavit-{$c['ref']}-certified.pdf" : "affidavit-{$c['ref']}.txt";
    $previewMime = $r['stamped_vault'] ? 'application/pdf' : 'text/plain';
    audit($preview ? 'affidavit.view' : 'affidavit.download', $c['ref']);
  }
  if ($preview) document_preview($u, $data, $name, $previewMime);
  header('Content-Type: ' . (str_ends_with($name, '.pdf') ? 'application/pdf' : 'application/octet-stream')); header('Content-Disposition: attachment; filename="' . preg_replace('/[^\w.\-]/', '_', $name) . '"'); header('Content-Length: ' . strlen($data)); echo $data; exit;
}

case 'sos': {
  $u = need(['citizen']); [$la, $ln] = coordinates($b, true);
  $active = $d->prepare("SELECT id FROM sos WHERE citizen_id=? AND status IN ('Open','Responding') ORDER BY id DESC LIMIT 1");
  $active->execute([$u['id']]);
  if ($sid = $active->fetchColumn()) out(['id' => (int)$sid]);
  $d->prepare('INSERT INTO sos(citizen_id,lat,lng,created,updated) VALUES(?,?,?,?,?)')->execute([$u['id'], $la, $ln, time(), time()]);
  $sid = (int)$d->lastInsertId(); audit('sos.raise', $la === null ? 'no GPS' : "$la,$ln"); out(['id' => $sid]);
}
case 'sos_update': {
  $u = need(['citizen']); [$lat, $lng] = coordinates($b);
  $id = (int)($b['id'] ?? 0);
  $st = $d->prepare("UPDATE sos SET lat=?,lng=?,updated=? WHERE id=? AND citizen_id=? AND status IN ('Open','Responding')");
  $st->execute([$lat, $lng, time(), $id, $u['id']]);
  if (!$st->rowCount()) out(['error' => 'Alert is resolved or unavailable'], 409);
  audit('sos.location_update', "Alert #$id location refreshed", $u);
  out(['ok' => 1]);
}
case 'sos_ack': {
  $u = need(['officer', 'admin']); $d->prepare("UPDATE sos SET status='Responding',ack_by=?,updated=? WHERE id=? AND status='Open'")->execute([$u['id'], time(), (int)($b['id'] ?? 0)]);
  audit('sos.ack', (string)($b['id'] ?? '')); out(['ok' => 1]);
}
case 'sos_resolve': {
  $u = need(['officer', 'admin']); $d->prepare("UPDATE sos SET status='Resolved',updated=? WHERE id=?")->execute([time(), (int)($b['id'] ?? 0)]);
  audit('sos.resolve', (string)($b['id'] ?? '')); out(['ok' => 1]);
}

case 'user_approval': {
  $u = need(['admin']);
  $decision = $b['decision'] ?? '';
  if (!in_array($decision, ['approve', 'reject'], true)) out(['error' => 'Choose approve or reject'], 400);
  $id = (int)($b['id'] ?? 0);
  $approval = $decision === 'approve' ? 'active' : 'rejected';
  $statement = $d->prepare("UPDATE users SET approval_status=? WHERE id=? AND approval_status='pending' AND role IN ('citizen','officer','admin')");
  $statement->execute([$approval, $id]);
  if (!$statement->rowCount()) out(['error' => 'This signup is not pending or has already been reviewed'], 409);
  audit('user.' . ($decision === 'approve' ? 'approved' : 'rejected'), 'Account #' . $id);
  out(['ok' => 1]);
}
case 'officer_suspend':
case 'user_suspend': {
  $admin = need(['admin']);
  $id = (int)($b['id'] ?? 0);
  $decision = (string)($b['decision'] ?? '');
  if (!in_array($decision, ['suspend', 'reinstate'], true) || $id < 1) out(['error' => 'Choose an account and a valid action.'], 400);
  if ($id === (int)$admin['id']) out(['error' => 'You cannot suspend your own account.'], 400);
  $targetQuery = $d->prepare("SELECT id,username,name,role,suspended,suspended_at FROM users WHERE id=?");
  $targetQuery->execute([$id]);
  $target = $targetQuery->fetch();
  if (!$target || !in_array($target['role'], ['officer','admin','citizen'], true)) out(['error' => 'Choose an existing Officer, Admin or Citizen.'], 400);
  if (($_GET['a'] ?? '') === 'officer_suspend' && $target['role'] !== 'officer') out(['error' => 'Only Officer accounts can be suspended here.'], 400);
  if ($decision === 'suspend') {
    $reason = str($b, 'reason', 500);
    if (mb_strlen($reason) < 10 || preg_match('/\p{Cc}/u', $reason)) out(['error' => 'Enter a clear suspension reason of 10–500 characters.'], 400);
    if ((int)$target['suspended']) out(['error' => 'This account is already suspended. Reinstate it before creating a new suspension.'],409);
    if ($target['role'] === 'admin') {
      $remaining=$d->prepare("SELECT COUNT(*) FROM users WHERE role='admin' AND approval_status='active' AND suspended=0 AND admin_setup_hash IS NULL AND id<>?");
      $remaining->execute([$id]);
      if (!(int)$remaining->fetchColumn()) out(['error'=>'At least one active Admin must remain.'],409);
    }
    $suspend=$d->prepare("UPDATE users SET suspended=1,suspension_reason=?,suspended_at=?,suspended_by=? WHERE id=? AND suspended=0 AND (role!='admin' OR EXISTS(SELECT 1 FROM users remaining WHERE remaining.role='admin' AND remaining.approval_status='active' AND remaining.suspended=0 AND remaining.admin_setup_hash IS NULL AND remaining.id<>users.id))");
    $suspend->execute([$reason, max(time(), (int)$target['suspended_at'] + 1), $admin['id'], $id]);
    if ($suspend->rowCount() !== 1) out(['error'=>'The account changed, or this would leave no active Admin. Refresh and try again.'],409);
    $d->prepare('DELETE FROM admin_lock WHERE user_id=?')->execute([$id]);
    audit($target['role'] . '.suspended', $target['username'] . ': ' . $reason, $admin);
    out(['ok' => 1, 'suspended' => 1]);
  }
  if (!(int)$target['suspended']) out(['error' => 'This account is not suspended.'], 409);
  $d->prepare('UPDATE users SET suspended=0 WHERE id=?')->execute([$id]);
  audit($target['role'] . '.reinstated', $target['username'] . ': ' . (string)$d->query('SELECT suspension_reason FROM users WHERE id=' . $id)->fetchColumn(), $admin);
  out(['ok' => 1, 'suspended' => 0]);
}
case 'user_password_reset': {
  $u = need(['admin']);
  $id = (int)($b['id'] ?? 0); $pw = password_value($b);
  password_need($pw);
  if ($id === (int)$u['id']) out(['error' => 'Use Change password to update your own account'], 400);
  $target = $d->prepare('SELECT username,role FROM users WHERE id=?'); $target->execute([$id]); $account = $target->fetch();
  if (!$account) out(['error' => 'Account not found'], 404);
  $d->prepare('UPDATE users SET pass_hash=?,admin_setup_hash=NULL,admin_setup_expires=NULL WHERE id=?')->execute([password_hash($pw, PASSWORD_DEFAULT), $id]);
  if ($account['role'] === 'admin') $d->prepare('DELETE FROM admin_lock WHERE user_id=?')->execute([$id]);
  audit('user.password_reset', "Account #$id ({$account['username']})", $u);
  out(['ok' => 1]);
}
case 'admin_add': admin_setup_issue($d,$b,false,'admin');
case 'officer_add': admin_setup_issue($d,$b,false,'officer');
case 'admin_setup_reissue': admin_setup_issue($d,$b,true);
case 'admin_setup_info': {
  $target=admin_setup_target($d,$b);
  out(['ok'=>1,'name'=>$target['name'],'username'=>$target['username'],'email'=>$target['email'],'role'=>$target['role'],'expires_at'=>$target['admin_setup_expires']]);
}
case 'admin_setup_complete': admin_setup_complete($d,$b);
case 'user_create': {
  $u = need(['admin']); $un = username_value($b); $n = str($b, 'name', 80); $r = (string)($b['role'] ?? ''); $pw = password_value($b);
  if (strlen($n) < 2 || $pw === '' || !in_array($r, ['officer', 'admin'], true)) out(['error' => 'Check the name, role and password'], 400);
  password_creation_need($pw);
  $email = $r === 'admin' ? admin_email_value($b) : null;
  if ($d->query('SELECT 1 FROM users WHERE username=' . $d->quote($un))->fetch()) out(['error' => 'That username is taken'], 409);
  $d->prepare('INSERT INTO users(username,name,role,pass_hash,created,email) VALUES(?,?,?,?,?,?)')->execute([$un, $n, $r, password_hash($pw, PASSWORD_DEFAULT), time(), $email]);
  audit('user.create', "$un ($r)"); out(['ok' => 1]);
}
case 'report_csv': {
  $u = need(['admin']);
  operational_report($d, $u, ['type' => 'cases', 'format' => 'csv']);
}
case 'operational_report': {
  $u = need(['admin']);
  operational_report($d, $u, $_GET);
}
case 'backup_archive': {
  $u = need(['admin']);
  $failures = $d->prepare("SELECT COUNT(*) FROM audit WHERE user_id=? AND action='backup.denied' AND ts>?");
  $failures->execute([$u['id'], time() - 600]);
  $failureCount = (int)$failures->fetchColumn(); $failures->closeCursor();
  if ($failureCount >= 5) out(['error' => 'Too many failed password confirmations. Try again in 10 minutes.'], 429);
  $passphrase = (string)($b['passphrase'] ?? '');
  if (strlen($passphrase) < 16 || strlen($passphrase) > 1024 || strpbrk($passphrase, "\r\n") !== false) out(['error' => 'Use a single-line backup passphrase of 16 to 1,024 bytes.'], 400);
  if (!hash_equals($passphrase, (string)($b['confirm'] ?? ''))) out(['error' => 'Backup passphrases do not match.'], 400);
  $hash = $d->query('SELECT pass_hash FROM users WHERE id=' . (int)$u['id'])->fetchColumn();
  if (!password_verify(password_value($b), $hash)) { audit('backup.denied', 'Administrator password confirmation failed'); out(['error' => 'Current administrator password is incorrect.'], 403); }
  // Fail before sending download headers if any file is absent or unreadable.
  $work = backup_workspace(rtrim(DATA, '/'));
  $streamLease = null;
  ignore_user_abort(true);
  set_time_limit(0);
  try {
    if (!is_file(DATA . '/master.key') && count(scandir(DATA . '/vault')) > 2) throw new RuntimeException('Master key missing from existing vault; backup cancelled.');
    master_key(); // Empty installations still need a key in their first archive.
    audit('backup.create', 'Encrypted recovery archive requested');
    $archive = backup_create($d, DATA, $passphrase, $work);
    sodium_memzero($passphrase);
    $verify = $work . '/verified';
    mkdir($verify, 0700);
    backup_extract($archive, (string)$b['passphrase'], $verify);
    backup_remove($verify);
    audit('backup.download', basename($archive) . ' verified; no server retention');
    $streamLease = fopen($work . '/.streaming', 'xb');
    if (!$streamLease || !flock($streamLease, LOCK_EX)) throw new RuntimeException('Cannot protect active download workspace.');
    // The completed archive is independent of live storage. Slow clients must
    // not block SOS/case requests, or the admin's own session heartbeat.
    flock($storageLock, LOCK_UN); fclose($storageLock);
    session_write_close();
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="smart-police-' . gmdate('Ymd-His') . '.spbk"');
    header('Content-Length: ' . filesize($archive));
    header('X-Accel-Buffering: no');
    $file = fopen($archive, 'rb');
    try { fpassthru($file); } finally { fclose($file); }
  } finally { try { backup_remove($work); } finally { if ($streamLease) fclose($streamLease); } }
  exit;
}
case 'case_pdf':
case 'backup_pdf': {
  $u = need($a === 'backup_pdf' ? ['admin'] : ['citizen', 'officer', 'admin']);
  $created = time(); $generated = date('Y-m-d H:i:s T (P)', $created);
  $lines = ['Generated by: ' . $u['name'] . ' (' . $u['role'] . ')',
    'Readable record backup. Not a restorable database or attachment archive.', ''];
  $caseId = null;
  if ($a === 'case_pdf') {
    $c = case_for($u, (int)($_GET['id'] ?? 0));
    if (!$c) out(['error' => 'Case not found'], 404);
    $caseId = (int)$c['id']; $title = 'CASE RECORD - ' . $c['ref'];
    $filename = $c['ref'] . '-' . date('Ymd-His', $created) . '.pdf';
    $lines = array_merge($lines, case_record_lines($c));
  } else {
    $title = 'SMART POLICE - RECORD BACKUP';
    $filename = 'smart-police-backup-' . date('Ymd-His', $created) . '.pdf';
    // All reads in a snapshot so one PDF cannot mix conflicting case states.
    $d->beginTransaction();
    foreach ($d->query('SELECT * FROM cases ORDER BY id') as $c) $lines = array_merge($lines, case_record_lines($c));
    $lines[] = 'SOS ALERT REGISTER';
    foreach ($d->query('SELECT s.*,u.name FROM sos s JOIN users u ON s.citizen_id=u.id ORDER BY s.id') as $s) {
      $lines[] = '#' . $s['id'] . ' | ' . $s['name'] . ' | ' . $s['status'] . ' | GPS: ' . ($s['lat'] ?? 'Unavailable') . ', ' . ($s['lng'] ?? 'Unavailable');
      $lines[] = 'Created: ' . date('c', (int)$s['created']) . ' | Updated: ' . date('c', (int)$s['updated']);
    }
    $lines[] = ''; $lines[] = 'AUDIT REGISTER';
    foreach ($d->query('SELECT ts,username,action,detail FROM audit ORDER BY id') as $r) $lines[] = date('c', (int)$r['ts']) . ' | ' . $r['username'] . ' | ' . $r['action'] . ' | ' . $r['detail'];
    $d->commit();
  }
  $bytes = record_pdf($title, $lines, $generated);
  $vault = vault_put($bytes);
  $d->prepare('INSERT INTO pdf_exports(user_id,case_id,filename,vault,sha256,created) VALUES(?,?,?,?,?,?)')->execute([$u['id'], $caseId, $filename, $vault, hash('sha256', $bytes), $created]);
  audit('pdf.export', $filename);
  header('Content-Type: application/pdf');
  header('Content-Disposition: attachment; filename="' . $filename . '"');
  header('Content-Length: ' . strlen($bytes)); echo $bytes; exit;
}
case 'settings_pdf': {
  $u = need(['admin']); $created = time(); $generated = date('Y-m-d H:i:s T (P)', $created);
  $stats = [
    'Cases' => (int)$d->query('SELECT COUNT(*) FROM cases')->fetchColumn(),
    'Evidence files' => (int)$d->query('SELECT COUNT(*) FROM evidence')->fetchColumn(),
    'Active Citizens' => (int)$d->query("SELECT COUNT(*) FROM users WHERE role='citizen' AND approval_status='active'")->fetchColumn(),
    'Active Officers' => (int)$d->query("SELECT COUNT(*) FROM users WHERE role='officer' AND approval_status='active' AND suspended=0")->fetchColumn(),
    'Active Administrators' => (int)$d->query("SELECT COUNT(*) FROM users WHERE role='admin' AND approval_status='active'")->fetchColumn(),
    'Pending account approvals' => (int)$d->query("SELECT COUNT(*) FROM users WHERE approval_status='pending'")->fetchColumn(),
    'Evidence awaiting review' => (int)$d->query("SELECT COUNT(*) FROM evidence WHERE status='Pending'")->fetchColumn(),
    'Affidavits awaiting certification' => (int)$d->query("SELECT COUNT(*) FROM affidavits WHERE status='Pending'")->fetchColumn(),
    'Active SOS alerts' => (int)$d->query("SELECT COUNT(*) FROM sos WHERE status IN ('Open','Responding')")->fetchColumn(),
    'Unassigned open cases' => (int)$d->query("SELECT COUNT(*) FROM cases WHERE officer_id IS NULL AND status!='Closed'")->fetchColumn()
  ];
  $lines = ['Generated by: ' . $u['name'] . ' (administrator)',
    'This snapshot records current system and synchronization status. It is not a recovery archive.', '',
    'LIVE SYNCHRONIZATION', 'Status: Connected to the application database',
    'Mode: Automatic dashboard refresh', 'Refresh interval: 3 seconds while the application is open',
    'Last successful server snapshot: ' . $generated, '',
    'BACKUP SETTINGS', 'Recovery backup: encrypted downloadable .spbk archive with a separate passphrase.',
    'Readable backup: timestamped PDF record snapshot, retained in the protected PDF archive.',
    'Operational reports: generated PDFs are retained in the protected PDF archive and audit logged.',
    'Saved PDFs are included in the encrypted recovery archive.', '', 'CURRENT SYSTEM TOTALS'];
  foreach ($stats as $name => $count) $lines[] = "$name: $count";
  $lines[] = ''; $lines[] = 'RECENT AUDIT ACTIVITY';
  $events = $d->query('SELECT ts,username,action,detail FROM audit ORDER BY id DESC LIMIT 30')->fetchAll();
  if (!$events) $lines[] = 'No audit activity recorded.';
  foreach ($events as $event) $lines[] = date('Y-m-d H:i:s T (P)', (int)$event['ts']) . ' | ' . ($event['username'] ?: 'System') . ' | ' . $event['action'] . ' | ' . $event['detail'];
  $filename = 'smart-police-settings-sync-' . date('Ymd-His', $created) . '.pdf';
  $bytes = record_pdf('SMART POLICE - SETTINGS AND SYNC', $lines, $generated);
  $vault = vault_put($bytes);
  $d->prepare('INSERT INTO pdf_exports(user_id,case_id,filename,vault,sha256,created) VALUES(?,NULL,?,?,?,?)')
    ->execute([$u['id'], $filename, $vault, hash('sha256', $bytes), $created]);
  audit('settings.export_pdf', $filename, $u);
  header('Content-Type: application/pdf');
  header('Content-Disposition: attachment; filename="' . $filename . '"');
  header('Content-Length: ' . strlen($bytes)); echo $bytes; exit;
}
default: out(['error' => 'Unknown action'], 404);
} } catch (Throwable $e) { error_log($e->getMessage()); out(['error' => 'Server error'], 500); }
