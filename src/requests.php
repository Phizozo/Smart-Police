<?php
declare(strict_types=1);

// ID details, selfies, source documents and immutable PDFs use the encrypted vault.
function request_can_read(array $user, array $request): bool {
    return $user['role'] === 'admin' ||
        ($user['role'] === 'citizen' && (int)$request['citizen_id'] === (int)$user['id']) ||
        ($user['role'] === 'officer' && (int)$request['officer_id'] === (int)$user['id']);
}

function request_find(PDO $db, int $id): array {
    $q = $db->prepare('SELECT r.*,c.name citizen_name,o.name officer_name,v.name reviewer_name,v.role reviewer_role FROM service_requests r JOIN users c ON c.id=r.citizen_id LEFT JOIN users o ON o.id=r.officer_id LEFT JOIN users v ON v.id=r.reviewer_id WHERE r.id=?');
    $q->execute([$id]); $request = $q->fetch();
    if (!$request) out(['error' => 'Request not found'], 404);
    return $request;
}

function request_files(PDO $db, int $id): array {
    $q = $db->prepare('SELECT id,kind,filename,mime,size,sha256 FROM request_files WHERE request_id=? ORDER BY id');
    $q->execute([$id]); return $q->fetchAll();
}

function requests_state(PDO $db, array $user): array {
    $where = match ($user['role']) {
        'citizen' => 'r.citizen_id=' . (int)$user['id'],
        'officer' => "((r.officer_id IS NULL AND r.status='Pending review') OR r.officer_id=" . (int)$user['id'] . ')',
        default => '1'
    };
    $rows = $db->query("SELECT r.*,c.name citizen_name,o.name officer_name,v.name reviewer_name,v.role reviewer_role,c.review_flag_reason,c.review_flagged_at,flagger.name review_flagged_by_name FROM service_requests r JOIN users c ON c.id=r.citizen_id LEFT JOIN users o ON o.id=r.officer_id LEFT JOIN users v ON v.id=r.reviewer_id LEFT JOIN users flagger ON flagger.id=c.review_flagged_by WHERE $where ORDER BY r.updated DESC,r.id DESC LIMIT 200")->fetchAll();
    foreach ($rows as &$row) {
        $allowed = request_can_read($user, $row);
        $row['has_receipt'] = $allowed && (bool)$row['receipt_vault'];
        $row['has_result'] = $allowed && (bool)$row['result_vault'];
        $row['files'] = $allowed ? request_files($db, (int)$row['id']) : [];
        if ($allowed) $row['details'] = json_decode(vault_get($row['details_vault']), true, 16, JSON_THROW_ON_ERROR);
        if ($user['role'] === 'citizen') unset($row['review_flag_reason'],$row['review_flagged_at'],$row['review_flagged_by_name']);
        if ($allowed && in_array($user['role'], ['officer','admin'], true)) {
            $photo = $db->prepare('SELECT face_vault FROM users WHERE id=?');
            $photo->execute([(int)$row['citizen_id']]);
            $row['citizen_face_available'] = (bool)$photo->fetchColumn();
        }
        foreach (['details_vault','details_sha256','receipt_vault','receipt_sha256','result_vault','result_sha256'] as $key) unset($row[$key]);
    }
    return $rows;
}

function requests_citizen_stats(PDO $db, int $id): array {
    $q = $db->prepare("SELECT COUNT(*) total_cases,COALESCE(SUM(status!='Closed'),0) open_cases FROM cases WHERE citizen_id=?");
    $q->execute([$id]); $stats = array_map('intval', $q->fetch());
    $q = $db->prepare("SELECT COUNT(*) service_requests,COALESCE(SUM(status IN('Pending review','In review')),0) pending_requests,COALESCE(SUM(status='Approved'),0) approved_requests FROM service_requests WHERE citizen_id=?");
    $q->execute([$id]); $stats += array_map('intval', $q->fetch());
    $q = $db->prepare("SELECT COUNT(*) FROM sos WHERE citizen_id=? AND status IN('Open','Responding')");
    $q->execute([$id]); $stats['active_sos'] = (int)$q->fetchColumn();
    $stats['total_submissions'] = $stats['total_cases'] + $stats['service_requests'];
    return $stats;
}

function request_upload(string $field, bool $imageOnly = false): array {
    $file = $_FILES[$field] ?? null;
    if (!is_array($file) || is_array($file['error'] ?? null) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        out(['error' => "Choose a valid file for " . str_replace('_', ' ', $field) . ' (maximum 10 MB).'], 400);
    }
    if (!is_uploaded_file($file['tmp_name']) || $file['size'] < 1 || $file['size'] > 10 * 1024 * 1024) out(['error' => 'Each attachment must be between 1 byte and 10 MB.'], 400);
    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']);
    $types = ['image/png' => ['png'], 'image/jpeg' => ['jpg','jpeg']];
    if (!$imageOnly) $types['application/pdf'] = ['pdf'];
    $name = basename(str_replace('\\', '/', (string)$file['name']));
    if (!isset($types[$mime]) || !in_array(strtolower(pathinfo($name, PATHINFO_EXTENSION)), $types[$mime], true)) out(['error' => str_replace('_', ' ', $field) . ($imageOnly ? ' must be a real PNG or JPEG image.' : ' must be a real PDF, PNG or JPEG file.')], 400);
    if (str_starts_with($mime, 'image/')) {
        $image = @getimagesize($file['tmp_name']);
        if (!$image || $image[0] < 1 || $image[1] < 1 || $image[0] * $image[1] > 50000000) out(['error' => 'Choose an image with valid dimensions, no more than 50 megapixels.'], 400);
    }
    $bytes = file_get_contents($file['tmp_name']);
    if ($bytes === false || ($mime === 'application/pdf' && !str_starts_with($bytes, '%PDF-'))) out(['error' => 'The uploaded file could not be read or is invalid.'], 400);
    $name = mb_substr(preg_replace('/[\x00-\x1f\x7f]/', '', mb_convert_encoding($name, 'UTF-8', 'UTF-8')), 0, 120);
    return ['kind' => $field, 'filename' => $name, 'mime' => $mime, 'size' => strlen($bytes), 'sha256' => hash('sha256', $bytes), 'bytes' => $bytes];
}

function request_store(string $bytes, array &$created): string {
    $vault = vault_put($bytes); $created[] = $vault;
    $path = DATA . '/vault/' . $vault;
    clearstatcache(true, $path);
    if (!is_file($path) || filesize($path) !== strlen($bytes) + 28) throw new RuntimeException('Request attachment could not be saved.');
    chmod($path, 0600);
    return $vault;
}

function request_pdf_bytes(array $request, array $details, array $files, bool $approved): string {
    $at = $approved ? (int)$request['reviewed_at'] : (int)$request['created'];
    $lines = [
        'Reference: ' . $request['ref'],
        'Service: ' . ($request['kind'] === 'affidavit' ? 'Affidavit request' : 'Document copy certification request'),
        'Citizen: ' . $request['citizen_name'],
        'ID number: ' . $details['id_number'],
        'Race (self-described, optional): ' . ($details['race'] ?: 'Not provided'),
        'Submitted: ' . date('Y-m-d H:i:s T (P)', (int)$request['created']),
        'Status at issue: ' . $request['status']
    ];
    if (!empty($details['document_type'])) $lines[] = 'Document type: ' . $details['document_type'];
    if (!empty($details['reason'])) $lines = array_merge($lines, ['', 'REASON', $details['reason']]);
    if ($request['kind'] === 'affidavit') $lines = array_merge($lines, ['', 'STATEMENT', $details['statement']]);
    if ($approved) $lines = array_merge($lines, [
        '', 'ELECTRONIC REVIEW STAMP', 'Reviewer: ' . $request['reviewer_name'] . ' (' . $request['reviewer_role'] . ')',
        'Reviewed: ' . date('Y-m-d H:i:s T (P)', $at),
        'Electronic signature: ' . request_signature($request['reviewer_name']),
        'Reviewer confirmed manual review of the identity details and camera capture.',
        'Reviewer confirmed review of the statement or original and copy.',
        'Review note: ' . $request['note']
    ]);
    $lines[] = ''; $lines[] = 'ATTACHMENT REGISTER - SHA-256 fingerprints of unchanged source files';
    foreach ($files as $file) {
        $lines[] = $file['kind'] . ': ' . $file['filename'];
        $lines[] = 'SHA-256: ' . $file['sha256'];
    }
    $lines = array_merge($lines, ['', 'PRIVACY AND LEGAL NOTICE',
        'Confidential electronic workflow record. No automated face matching was performed.',
        'Remote review does not establish in-person commissioning or statutory certification.',
        'Present original documents to an authorised official where legally required.',
        'Uploaded source documents are unchanged. This record is not a cryptographic digital signature.'
    ]);
    $title = $approved
        ? ($request['kind'] === 'affidavit' ? 'Affidavit Report' : 'SMART POLICE - REVIEW RECORD')
        : 'SMART POLICE - SUBMISSION RECEIPT';
    return record_pdf($title, $lines, date('Y-m-d H:i:s T (P)', $at));
}

function request_create(PDO $db, array $body): never {
    $user = need(['citizen']);
    $kind = str($body, 'kind', 20);
    if (!in_array($kind, ['affidavit','certification'], true)) out(['error' => 'Choose affidavit or certification.'], 400);
    $details = ['id_number' => str($body, 'id_number', 30), 'race' => str($body, 'race', 80), 'reason' => str($body, 'reason', 2000), 'statement' => str($body, 'statement', 20000)];
    if (!preg_match('/^[\p{L}\p{N} -]{3,30}$/uD', $details['id_number'])) out(['error' => 'Enter an ID number of 3–30 letters, numbers, spaces or hyphens.'], 400);
    if (preg_match('/\p{Cc}/u', $details['race'])) out(['error' => 'Enter Race as plain text without control characters.'], 400);
    if ($kind === 'affidavit' && (mb_strlen($details['reason']) < 10 || mb_strlen($details['statement']) < 20)) out(['error' => 'Provide a reason of at least 10 characters and an affidavit statement of at least 20 characters.'], 400);
    if ($kind === 'certification') {
        $details['document_type'] = str($body, 'document_type', 40);
        if (!in_array($details['document_type'], ['Identity document','Matric','Qualification','Others'], true)) out(['error' => 'Select a valid document type.'], 400);
        $details['reason'] = ''; $details['statement'] = '';
    }
    if (($body['consent'] ?? '') !== 'yes') out(['error' => 'Confirm permission to share your ID, selfie and documents for Officer review.'], 400);
    $q = $db->prepare("SELECT COUNT(*) FROM service_requests WHERE citizen_id=? AND (created>? OR status IN('Pending review','In review'))");
    $q->execute([$user['id'], time() - 600]);
    if ((int)$q->fetchColumn() >= 50) out(['error' => 'Too many outstanding requests. Wait for Officer review before submitting more.'], 429);
    $q = $db->prepare('SELECT COUNT(*) FROM service_requests WHERE citizen_id=? AND created>?');
    $q->execute([$user['id'], time() - 600]);
    if ((int)$q->fetchColumn() >= 10) out(['error' => 'Please wait 10 minutes before submitting more requests.'], 429);
    $fields = $kind === 'affidavit' ? ['id_proof','selfie'] : ['selfie','original','copy'];
    if (array_diff(array_keys($_FILES), $fields)) out(['error' => 'Unexpected attachment field.'], 400);
    $files = [];
    foreach ($fields as $field) $files[] = request_upload($field, $field === 'selfie');
    $created = [];
    $db->beginTransaction();
    try {
        $json = json_encode($details, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        $detailVault = request_store($json, $created); $now = time();
        $db->prepare('INSERT INTO service_requests(citizen_id,kind,details_vault,details_sha256,created,updated) VALUES(?,?,?,?,?,?)')->execute([$user['id'], $kind, $detailVault, hash('sha256', $json), $now, $now]);
        $id = (int)$db->lastInsertId(); $ref = sprintf('SR-%s-%05d', date('y'), $id);
        $db->prepare('UPDATE service_requests SET ref=? WHERE id=?')->execute([$ref, $id]);
        foreach ($files as &$file) {
            $vault = request_store($file['bytes'], $created); unset($file['bytes']);
            $db->prepare('INSERT INTO request_files(request_id,kind,filename,mime,size,sha256,vault) VALUES(?,?,?,?,?,?,?)')->execute([$id,$file['kind'],$file['filename'],$file['mime'],$file['size'],$file['sha256'],$vault]);
        } unset($file);
        $request = request_find($db, $id);
        $receipt = request_pdf_bytes($request, $details, $files, false);
        $receiptVault = request_store($receipt, $created);
        $db->prepare('UPDATE service_requests SET receipt_vault=?,receipt_sha256=? WHERE id=?')->execute([$receiptVault,hash('sha256',$receipt),$id]);
        audit('request.submit', $ref . ' | ' . $kind, $user);
        $db->commit();
    } catch (Throwable $error) {
        if ($db->inTransaction()) $db->rollBack();
        foreach ($created as $vault) @unlink(DATA . '/vault/' . $vault);
        throw $error;
    }
    out(['ok'=>1, 'id'=>$id, 'ref'=>$ref]);
}

function request_claim(PDO $db, array $body): never {
    $user = need(['officer']); $id = (int)($body['id'] ?? 0);
    $q = $db->prepare("UPDATE service_requests SET officer_id=?,status='In review',updated=? WHERE id=? AND officer_id IS NULL AND status='Pending review'");
    $q->execute([$user['id'],time(),$id]);
    if (!$q->rowCount()) out(['error' => 'This request is already claimed or unavailable.'], 409);
    audit('request.claim', request_find($db, $id)['ref'], $user); out(['ok'=>1]);
}

function request_review(PDO $db, array $body): never {
    $user = need(['officer','admin']);
    $request = request_find($db, (int)($body['id'] ?? 0));
    if (!request_can_read($user, $request)) out(['error'=>'Claim this request before reviewing its private documents.'], 403);
    if (!in_array($request['status'], ['Pending review','In review'], true)) out(['error'=>'This request has already been decided.'], 409);
    if ($user['role'] === 'officer' && $request['status'] !== 'In review') out(['error'=>'Claim this request before reviewing it.'], 409);
    $previousStatus = $request['status'];
    $decision = str($body,'decision',10); $note = str($body,'note',2000);
    if (!in_array($decision,['approve','reject'],true) || mb_strlen($note)<10) out(['error'=>'Choose approve or reject and provide a review note of at least 10 characters.'], 400);
    $approved = $decision === 'approve';
    if ($approved && (($body['identity_checked']??'')!=='yes' || ($body['documents_checked']??'')!=='yes')) out(['error'=>'Confirm that you reviewed the identity details and camera capture and checked the statement or original and copy.'],400);
    $request['status'] = $approved ? 'Approved' : 'Rejected';
    $request['note'] = $note; $request['reviewed_at'] = $request['updated'] = time();
    $request['reviewer_name'] = $user['name']; $request['reviewer_role'] = $user['role'];
    $created = []; $resultVault = $resultHash = null;
    $db->beginTransaction();
    try {
        if ($approved) {
            $details = json_decode(vault_get($request['details_vault']),true,16,JSON_THROW_ON_ERROR);
            $pdf = request_stamped_pdf($db,$request,$details,request_files($db,(int)$request['id']));
            $resultVault = request_store($pdf,$created); $resultHash = hash('sha256',$pdf);
        }
        $q = $db->prepare("UPDATE service_requests SET status=?,note=?,reviewed_at=?,updated=?,identity_checked=?,documents_checked=?,result_vault=?,result_sha256=?,reviewer_id=?,result_format=? WHERE id=? AND status=? AND officer_id IS ?");
        $q->execute([$request['status'],$note,$request['reviewed_at'],$request['updated'],(int)$approved,(int)$approved,$resultVault,$resultHash,$user['id'],$approved?'stamped_document':'review_record',$request['id'],$previousStatus,$request['officer_id']]);
        if (!$q->rowCount()) throw new RuntimeException('The request was changed by another review.');
        audit('request.' . $decision, $request['ref'], $user); $db->commit();
    } catch (Throwable $error) {
        if ($db->inTransaction()) $db->rollBack();
        foreach ($created as $vault) @unlink(DATA . '/vault/' . $vault);
        if ($error instanceof InvalidArgumentException) out(['error'=>$error->getMessage()],400);
        throw $error;
    }
    out(['ok'=>1]);
}

function request_download(PDO $db): never {
    $preview = ($_GET['preview'] ?? '') === '1';
    $user = need($preview ? ['officer','admin'] : ['citizen','officer','admin']);
    $request = request_find($db,(int)($_GET['id']??0));
    if (!request_can_read($user,$request)) out(['error'=>'Request not found'],404);
    if (isset($_GET['file_id'])) {
        $q = $db->prepare('SELECT * FROM request_files WHERE id=? AND request_id=?'); $q->execute([(int)$_GET['file_id'],$request['id']]); $file=$q->fetch();
        if (!$file) out(['error'=>'Attachment not found'],404);
        $vault=$file['vault']; $name=$file['filename']; $mime=$file['mime']; $sha=$file['sha256']; $label=$file['kind'];
    } else {
        $type = $_GET['pdf']??'';
        if (!in_array($type,['receipt','result'],true) || !$request[$type.'_vault']) out(['error'=>'PDF is not available'],404);
        $vault=$request[$type.'_vault']; $sha=$request[$type.'_sha256']; $mime='application/pdf'; $name=$request['ref'].'-'.$type.'.pdf'; $label=$type;
        if ($type==='result' && $request['result_format']==='stamped_document') $name=$request['ref'].($request['kind']==='affidavit'?'-affidavit-report.pdf':'-stamped-copy.pdf');
    }
    $bytes=vault_get($vault);
    if (!hash_equals($sha,hash('sha256',$bytes))) throw new RuntimeException('Request attachment integrity check failed.');
    audit($preview ? 'request.view' : 'request.download',$request['ref'].' | '.$label,$user);
    if ($preview) document_preview($user,$bytes,$name,$mime);
    header('Content-Type: '.$mime); header('Content-Disposition: attachment; filename="'.preg_replace('/[^\w.\-]/','_',$name).'"');
    header('Content-Length: '.strlen($bytes)); echo $bytes; exit;
}

function request_face_preview(PDO $db): never {
    $user = need(['officer','admin']);
    $request = request_find($db, (int)($_GET['id'] ?? 0));
    if (!request_can_read($user, $request)) out(['error'=>'Request not found'],404);
    $q = $db->prepare("SELECT face_vault,face_sha256,face_mime FROM users WHERE id=? AND role='citizen'");
    $q->execute([(int)$request['citizen_id']]);
    $photo = $q->fetch();
    if (!$photo || !$photo['face_vault']) out(['error'=>'Citizen camera photo is not available.'],404);
    $bytes = vault_get($photo['face_vault']);
    if (!hash_equals($photo['face_sha256'], hash('sha256', $bytes))) throw new RuntimeException('Citizen camera photo integrity check failed.');
    $name = 'citizen-camera-photo.' . ($photo['face_mime'] === 'image/png' ? 'png' : 'jpg');
    audit('request.face_view', $request['ref'] . ' | Citizen account photo', $user);
    if (($_GET['preview'] ?? '') === '1') document_preview($user, $bytes, $name, $photo['face_mime']);
    header('Content-Type: ' . $photo['face_mime']);
    header('Content-Disposition: attachment; filename="' . $name . '"');
    header('Cache-Control: private, no-store');
    header('X-Content-Type-Options: nosniff');
    header('Content-Length: ' . strlen($bytes));
    echo $bytes; exit;
}

function citizen_face_update(PDO $db, array $body): never {
    $user = need(['citizen']);
    if (($body['face_consent'] ?? '') !== 'yes') out(['error'=>'Confirm permission to store this camera photo for authorised human review.'],400);
    if (array_diff(array_keys($_FILES), ['selfie'])) out(['error'=>'Unexpected camera attachment.'],400);
    $photo = request_upload('selfie', true);
    $q = $db->prepare('SELECT face_vault FROM users WHERE id=? AND role=\'citizen\'');
    $q->execute([(int)$user['id']]);
    $oldVault = $q->fetchColumn();
    $created = [];
    $db->beginTransaction();
    try {
        $vault = request_store($photo['bytes'], $created);
        $db->prepare('UPDATE users SET face_vault=?,face_sha256=?,face_mime=?,face_updated=? WHERE id=? AND role=\'citizen\'')
            ->execute([$vault,$photo['sha256'],$photo['mime'],time(),(int)$user['id']]);
        audit('user.face_update', 'Citizen account photo replaced; consent recorded', $user);
        $db->commit();
    } catch (Throwable $error) {
        if ($db->inTransaction()) $db->rollBack();
        foreach ($created as $name) @unlink(DATA . '/vault/' . $name);
        throw $error;
    }
    if (is_string($oldVault) && $oldVault !== '' && $oldVault !== $vault) @unlink(DATA . '/vault/' . basename($oldVault));
    out(['ok'=>1]);
}
