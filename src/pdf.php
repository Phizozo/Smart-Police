<?php
declare(strict_types=1);

// Dependency-free, paginated record PDFs; timestamps are authoritative server time.
function record_pdf(string $title, array $lines, string $generated): string {
    $escape = static function (string $text): string {
        $text = iconv('UTF-8', 'Windows-1252//TRANSLIT', $text) ?: $text;
        $text = preg_replace('/[\x00-\x08\x0b-\x1f]/', ' ', $text);
        return str_replace(['\\', '(', ')'], ['\\\\', '\\(', '\\)'], $text);
    };
    $wrapped = [];
    foreach ($lines as $line) {
        foreach (explode("\n", wordwrap(str_replace("\r", '', (string)$line), 88, "\n", true)) as $part) {
            $wrapped[] = $part;
        }
    }
    $chunks = array_chunk($wrapped ?: ['No records.'], 43);
    $pdf = "%PDF-1.4\n";
    $offsets = [];
    $add = static function (string $object) use (&$pdf, &$offsets): void {
        $offsets[] = strlen($pdf);
        $pdf .= count($offsets) . " 0 obj\n$object\nendobj\n";
    };
    $kids = '';
    foreach ($chunks as $i => $_) $kids .= (5 + 2 * $i) . ' 0 R ';
    $add('<< /Type /Catalog /Pages 2 0 R >>');
    $add('<< /Type /Pages /Kids [' . $kids . '] /Count ' . count($chunks) . ' >>');
    $add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    $add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    foreach ($chunks as $i => $chunk) {
        $stream = "0.06 0.24 0.64 rg 42 754 511 55 re f\n1 1 1 rg\n";
        $stream .= 'BT /F2 17 Tf 55 777 Td (' . $escape($title) . ") Tj ET\n";
        $stream .= '0.15 0.2 0.3 rg BT /F1 8 Tf 42 735 Td (Generated: ' . $escape($generated) . ") Tj ET\n";
        $stream .= "BT /F1 10 Tf 14 TL 42 710 Td\n";
        foreach ($chunk as $line) $stream .= '(' . $escape($line) . ") Tj T*\n";
        $stream .= "ET\nBT /F1 8 Tf 42 55 Td (CONFIDENTIAL - Smart Police record snapshot) Tj ET\n";
        $stream .= 'BT /F1 8 Tf 465 55 Td (Page ' . ($i + 1) . ' of ' . count($chunks) . ") Tj ET\n";
        $add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' . (6 + 2 * $i) . ' 0 R >>');
        $add('<< /Length ' . strlen($stream) . " >>\nstream\n{$stream}endstream");
    }
    $xref = strlen($pdf);
    $pdf .= "xref\n0 " . (count($offsets) + 1) . "\n0000000000 65535 f \n";
    foreach ($offsets as $offset) $pdf .= sprintf("%010d 00000 n \n", $offset);
    $pdf .= "trailer\n<< /Size " . (count($offsets) + 1) . " /Root 1 0 R >>\nstartxref\n$xref\n%%EOF\n";
    return $pdf;
}

function case_record_lines(array $case): array {
    $d = db(); $id = (int)$case['id'];
    $q = $d->prepare('SELECT name,email,phone,residential_address FROM users WHERE id=?');
    $q->execute([$case['citizen_id']]); $citizen = $q->fetch() ?: [];
    $q = $d->prepare('SELECT name FROM users WHERE id=?');
    $q->execute([$case['officer_id']]); $officer = $q->fetchColumn();
    $lines = [
        'CASE ' . $case['ref'] . ' - ' . $case['title'],
        'Type: ' . $case['type'] . ' | Status: ' . $case['status'],
        'Citizen: ' . ($citizen['name'] ?? '') . ' | Officer: ' . ($officer ?: 'Unassigned'),
        'Residential address: ' . ($citizen['residential_address'] ?? 'Not provided'),
        'Phone: ' . ($citizen['phone'] ?? 'Not provided') . ' | Email: ' . ($citizen['email'] ?? 'Not provided'),
        'Filed: ' . date('Y-m-d H:i:s T (P)', (int)$case['created']),
        'Updated: ' . date('Y-m-d H:i:s T (P)', (int)$case['updated']),
        'Location: ' . ($case['location'] ?: 'Not provided'), '',
        'DESCRIPTION', $case['description'], '', 'PROGRESS'
    ];
    foreach ($d->query("SELECT * FROM case_events WHERE case_id=$id ORDER BY id") as $event) {
        $lines[] = date('Y-m-d H:i:s T', (int)$event['ts']) . ' | ' . $event['by_name'] . ' | ' . $event['text'];
    }
    $lines[] = ''; $lines[] = 'EVIDENCE REGISTER (original attachments are stored separately)';
    foreach ($d->query("SELECT * FROM evidence WHERE case_id=$id ORDER BY id") as $e) {
        $lines[] = $e['filename'] . ' | ' . $e['size'] . ' bytes | ' . $e['status'];
        if ($e['note']) $lines[] = 'Review note: ' . $e['note'];
    }
    $lines[] = ''; $lines[] = 'AFFIDAVITS';
    foreach ($d->query("SELECT * FROM affidavits WHERE case_id=$id ORDER BY id") as $af) {
        $lines[] = 'Affidavit #' . $af['id'] . ' | ' . $af['status'];
        $lines[] = 'Source SHA-256: ' . $af['sha256'];
        if ($af['certified_at']) $lines[] = 'Certified: ' . date('Y-m-d H:i:s T (P)', (int)$af['certified_at']);
        $lines[] = vault_get($af['vault']);
        $lines[] = 'Stamped PDFs are available as separate downloads after certification.';
    }
    return array_merge($lines, ['', str_repeat('-', 70), '']);
}
