<?php
declare(strict_types=1);

// Reuse each download's record-level permission checks. Never render arbitrary
// uploaded HTML/SVG or infer a safe content type from a user-supplied filename.
function document_preview(array $user, string $bytes, string $name, ?string $trustedMime = null): never {
    if (!in_array($user['role'], ['officer','admin'], true)) out(['error'=>'Document viewing is available to authorised staff only.'],403);
    $mime = $trustedMime ?? (new finfo(FILEINFO_MIME_TYPE))->buffer($bytes);
    if (!in_array($mime, ['application/pdf','image/png','image/jpeg','text/plain'], true)) {
        out(['error'=>'This file type cannot be viewed in the portal. Use Download original to open it with an appropriate application.'],415);
    }
    if (str_starts_with($mime, 'image/') && @getimagesizefromstring($bytes) === false) out(['error'=>'This image cannot be displayed. Download the original to inspect it.'],415);
    if ($mime === 'application/pdf' && !str_starts_with($bytes, '%PDF-')) out(['error'=>'This file is not a supported PDF. Download the original to inspect it.'],415);
    header('Content-Type: '.$mime.($mime === 'text/plain' ? '; charset=UTF-8' : ''));
    header('Content-Disposition: inline; filename="'.preg_replace('/[^\w.\-]/','_',$name).'"');
    header('Cache-Control: private, no-store');
    header('Cross-Origin-Resource-Policy: same-origin');
    header("Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'");
    header('Content-Length: '.strlen($bytes));
    echo $bytes;
    exit;
}
