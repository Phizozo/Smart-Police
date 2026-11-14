<?php
declare(strict_types=1);

function report_date(mixed $value): ?DateTimeImmutable {
    if ($value === null || $value === '') return null;
    if (!is_string($value)) out(['error' => 'Choose dates in YYYY-MM-DD format'], 400);
    $date = DateTimeImmutable::createFromFormat('!Y-m-d', $value);
    if (!$date || $date->format('Y-m-d') !== $value) out(['error' => 'Choose valid dates in YYYY-MM-DD format'], 400);
    return $date;
}

function csv_safe_cell(mixed $value): string {
    $text = (string)($value ?? '');
    // Protect every user-controlled cell, including leading whitespace/control characters.
    return is_string($value) && preg_match('/^[\s\x00-\x20]*[=+\-@]/u', $text) ? "'" . $text : $text;
}

function operational_report(PDO $d, array $user, array $query): never {
    $titles = ['cases' => 'Case register', 'status' => 'Case status summary',
        'officers' => 'Officer workload', 'sos' => 'SOS alert register', 'audit' => 'Security audit'];
    $type = $query['type'] ?? 'cases'; $format = $query['format'] ?? 'pdf';
    if (!is_string($type) || !isset($titles[$type]) || !in_array($format, ['pdf', 'csv'], true)) out(['error' => 'Choose one of the five reports and PDF or CSV format'], 400);
    $from = report_date($query['from'] ?? null); $to = report_date($query['to'] ?? null);
    if ($from && $to && $from > $to) out(['error' => 'The start date must not be after the end date'], 400);
    $column = $type === 'audit' ? 'a.ts' : ($type === 'sos' ? 's.created' : 'c.created');
    $conditions = []; $params = [];
    if ($from) { $conditions[] = "$column >= ?"; $params[] = $from->getTimestamp(); }
    if ($to) { $conditions[] = "$column < ?"; $params[] = $to->modify('+1 day')->getTimestamp(); }
    $filter = $conditions ? implode(' AND ', $conditions) : '1=1';
    $stamp = static fn($ts): string => date('Y-m-d H:i:s T (P)', (int)$ts);
    switch ($type) {
        case 'cases':
            $headers = ['Reference', 'Title', 'Type', 'Status', 'Citizen', 'Officer', 'Filed', 'Updated'];
            $sql = "SELECT c.ref,c.title,c.type,c.status,cu.name,COALESCE(ou.name,'Unassigned'),c.created,c.updated
                FROM cases c JOIN users cu ON cu.id=c.citizen_id LEFT JOIN users ou ON ou.id=c.officer_id WHERE $filter ORDER BY c.id";
            break;
        case 'status':
            $headers = ['Status', 'Case count'];
            $sql = "SELECT c.status,COUNT(*) FROM cases c WHERE $filter GROUP BY c.status ORDER BY c.status";
            break;
        case 'officers':
            $headers = ['Officer', 'Username', 'Total cases', 'Active cases', 'Closed cases'];
            $sql = "SELECT u.name,u.username,COUNT(c.id),
                SUM(CASE WHEN c.id IS NOT NULL AND c.status!='Closed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN c.status='Closed' THEN 1 ELSE 0 END)
                FROM users u LEFT JOIN cases c ON c.officer_id=u.id AND $filter
                WHERE u.role='officer' AND u.approval_status='active' GROUP BY u.id ORDER BY u.name";
            break;
        case 'sos':
            $headers = ['Alert ID', 'Citizen', 'Status', 'Latitude', 'Longitude', 'Raised', 'Updated', 'Responding staff'];
            $sql = "SELECT s.id,u.name,s.status,s.lat,s.lng,s.created,s.updated,COALESCE(o.name,'Not assigned')
                FROM sos s JOIN users u ON u.id=s.citizen_id LEFT JOIN users o ON o.id=s.ack_by WHERE $filter ORDER BY s.id";
            break;
        default:
            $headers = ['When', 'Username', 'Action', 'Detail', 'IP address'];
            $sql = "SELECT a.ts,COALESCE(a.username,'Anonymous'),a.action,a.detail,a.ip FROM audit a WHERE $filter ORDER BY a.id";
    }
    $stmt = $d->prepare($sql); $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_NUM);
    foreach ($rows as &$row) {
        foreach (match ($type) { 'cases' => [6, 7], 'sos' => [5, 6], 'audit' => [0], default => [] } as $index) $row[$index] = $stamp($row[$index]);
    }
    unset($row);
    $created = time(); $generated = $stamp($created);
    $period = ($from?->format('Y-m-d') ?? 'Beginning') . ' to ' . ($to?->format('Y-m-d') ?? 'Now') . ' (inclusive, Africa/Johannesburg)';
    $basis = $type === 'audit' ? 'Audit event date' : ($type === 'officers' ? 'Case filing date; current assignments and statuses; officers with zero cases included' : 'Filing/creation date; current status');
    $filename = "smart-police-$type-" . date('Ymd-His', $created) . ".$format";
    if ($format === 'csv') {
        audit('report.export', "$type CSV | $period", $user);
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        $file = fopen('php://output', 'w');
        foreach ([['Report', $titles[$type]], ['Generated', $generated], ['Period', $period], ['Date basis', $basis], [], $headers] as $row) fputcsv($file, array_map('csv_safe_cell', $row), ',', '"', '');
        foreach ($rows as $row) fputcsv($file, array_map('csv_safe_cell', $row), ',', '"', '');
        fclose($file); exit;
    }
    $lines = ['Generated by: ' . $user['name'], 'Period: ' . $period, 'Date basis: ' . $basis,
        'Rows: ' . count($rows), 'Current database records; this report is not a recovery archive.', ''];
    if (!$rows) $lines[] = 'No matching records.';
    foreach ($rows as $index => $row) {
        $lines[] = 'RECORD ' . ($index + 1);
        foreach ($headers as $i => $header) $lines[] = $header . ': ' . ($row[$i] ?? 'Not recorded');
        $lines[] = '';
    }
    $bytes = record_pdf('SMART POLICE - ' . strtoupper($titles[$type]), $lines, $generated);
    $vault = vault_put($bytes);
    $d->prepare('INSERT INTO pdf_exports(user_id,case_id,filename,vault,sha256,created) VALUES(?,NULL,?,?,?,?)')
        ->execute([$user['id'], $filename, $vault, hash('sha256', $bytes), $created]);
    audit('report.export', "$type PDF | $period", $user);
    header('Content-Type: application/pdf');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Content-Length: ' . strlen($bytes));
    echo $bytes; exit;
}
