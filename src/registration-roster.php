<?php
declare(strict_types=1);

function registration_roster_file(): string {
    return rtrim(DATA, '/') . '/onedrive-registration-roster.json';
}

function registration_roster_web_url(mixed $value): ?string {
    if (!is_string($value) || $value === '') return null;
    $parts = parse_url($value);
    if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https') return null;
    $host = strtolower((string)($parts['host'] ?? ''));
    if ($host !== '1drv.ms' && $host !== 'onedrive.live.com' && !str_ends_with($host, '.sharepoint.com')) return null;
    return $value;
}

function registration_roster_status(): array {
    $empty = ['schema_version' => 0, 'synced' => false, 'last_sync' => null, 'row_count' => 0, 'sheet_count' => 0, 'web_url' => null, 'error' => null];
    $path = registration_roster_file();
    if (!is_file($path)) return $empty;
    $status = json_decode((string)@file_get_contents($path), true);
    if (!is_array($status)) return $empty;
    $currentFormat = (int)($status['schema_version'] ?? 0) >= 2;
    return [
        'schema_version' => $currentFormat ? 2 : 0,
        'synced' => $currentFormat && (bool)($status['synced'] ?? false),
        'last_sync' => isset($status['last_sync']) ? (int)$status['last_sync'] : null,
        'row_count' => max(0, (int)($status['row_count'] ?? 0)),
        'sheet_count' => max(0, (int)($status['sheet_count'] ?? 0)),
        'web_url' => registration_roster_web_url($status['web_url'] ?? null),
        'error' => isset($status['error']) && is_string($status['error'])
            ? mb_substr($status['error'], 0, 300)
            : ($currentFormat ? null : 'The existing workbook needs a full database sync.'),
    ];
}

function registration_roster_save_status(array $status): void {
    $path = registration_roster_file();
    $tmp = $path . '.' . bin2hex(random_bytes(6)) . '.tmp';
    $json = json_encode($status, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if (!is_string($json) || file_put_contents($tmp, $json, LOCK_EX) === false) throw new RuntimeException('Could not save OneDrive sync status.');
    @chmod($tmp, 0600);
    if (!rename($tmp, $path)) { @unlink($tmp); throw new RuntimeException('Could not update OneDrive sync status.'); }
    @chmod($path, 0600);
}

function registration_roster_export_sheets(PDO $db): array {
    $specs = [
        ['users', 'Users', 'SPUsers',
            ['Account ID','Username','Full name','Role','Registered at (SAST)','Approval status','Email','Residential address','Phone','Suspended','Suspension reason','Suspended at (SAST)','Suspended by account ID'],
            ['id','username','name','role','created','approval_status','email','residential_address','phone','suspended','suspension_reason','suspended_at','suspended_by'],
            ['created','suspended_at']],
        ['cases', 'Cases', 'SPCases',
            ['Case ID','Reference','Citizen account ID','Title','Type','Description','Incident location','Status','Officer account ID','Created at (SAST)','Updated at (SAST)'],
            ['id','ref','citizen_id','title','type','description','location','status','officer_id','created','updated'],
            ['created','updated']],
        ['case_events', 'Case events', 'SPCaseEvents',
            ['Event ID','Case ID','Event','Recorded by','Recorded at (SAST)'],
            ['id','case_id','text','by_name','ts'],
            ['ts']],
        ['evidence', 'Evidence', 'SPEvidence',
            ['Evidence ID','Case ID','Uploader account ID','Filename','File size (bytes)','Review status','Review note','Reviewer account ID','Uploaded at (SAST)'],
            ['id','case_id','uploader_id','filename','size','status','note','reviewer_id','created'],
            ['created']],
        ['affidavits', 'Affidavits', 'SPAffidavits',
            ['Affidavit ID','Case ID','Citizen account ID','Status','Officer account ID','Submitted at (SAST)','Certified at (SAST)'],
            ['id','case_id','citizen_id','status','officer_id','created','certified_at'],
            ['created','certified_at']],
        ['sos', 'SOS', 'SPSOS',
            ['SOS ID','Citizen account ID','Latitude','Longitude','Status','Acknowledged by account ID','Created at (SAST)','Updated at (SAST)'],
            ['id','citizen_id','lat','lng','status','ack_by','created','updated'],
            ['created','updated']],
        ['audit', 'Audit', 'SPAudit',
            ['Audit ID','Time (SAST)','Account ID','Username','Action','Detail'],
            ['id','ts','user_id','username','action','detail'],
            ['ts']],
        ['pdf_exports', 'PDF exports', 'SPPdfExports',
            ['PDF ID','Account ID','Case ID','Filename','Created at (SAST)'],
            ['id','user_id','case_id','filename','created'],
            ['created']],
        ['service_requests', 'Service requests', 'SPServiceRequests',
            ['Request ID','Reference','Citizen account ID','Service type','Status','Officer account ID','Review note','Identity checked','Documents checked','Created at (SAST)','Updated at (SAST)','Reviewed at (SAST)','Reviewer account ID','Result format'],
            ['id','ref','citizen_id','kind','status','officer_id','note','identity_checked','documents_checked','created','updated','reviewed_at','reviewer_id','result_format'],
            ['created','updated','reviewed_at']],
        ['request_files', 'Request files', 'SPRequestFiles',
            ['File ID','Request ID','File type','Filename','MIME type','File size (bytes)'],
            ['id','request_id','kind','filename','mime','size'],
            []],
    ];
    $known = array_merge(array_column($specs, 0), ['admin_lock']);
    $actual = $db->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")->fetchAll(PDO::FETCH_COLUMN);
    if (array_diff($actual, $known)) throw new RuntimeException('A database table is not covered by the safe Excel export map.');

    $timezone = new DateTimeZone('Africa/Johannesburg');
    $sheets = [];
    foreach ($specs as [$table, $sheetName, $tableName, $headers, $fields, $dateFields]) {
        $quotedFields = array_map(static fn(string $field): string => '"' . str_replace('"', '""', $field) . '"', $fields);
        $quotedTable = '"' . str_replace('"', '""', $table) . '"';
        $rows = [];
        $query = $db->query('SELECT ' . implode(',', $quotedFields) . ' FROM ' . $quotedTable . ' ORDER BY "id" DESC');
        while ($values = $query->fetch(PDO::FETCH_NUM)) {
            foreach ($fields as $index => $field) {
                if (in_array($field, $dateFields, true) && $values[$index] !== null) {
                    $values[$index] = (new DateTimeImmutable('@' . (int)$values[$index]))->setTimezone($timezone)->format('Y-m-d H:i:s T');
                }
            }
            $rows[] = $values;
        }
        $sheets[] = ['name' => $sheetName, 'tableName' => $tableName, 'headers' => $headers, 'rows' => $rows];
    }
    return $sheets;
}

function registration_roster_install_change_tracking(PDO $db): void {
    $db->exec('CREATE TEMP TABLE IF NOT EXISTS sp_sync_marker(changed INTEGER NOT NULL CHECK(changed IN (0,1)))');
    $db->exec('DELETE FROM temp.sp_sync_marker');
    $db->exec('INSERT INTO temp.sp_sync_marker(changed) VALUES(0)');
    $tables = $db->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")->fetchAll(PDO::FETCH_COLUMN);
    foreach ($tables as $table) {
        if ($table === 'admin_lock') continue;
        $quotedTable = '"' . str_replace('"', '""', $table) . '"';
        $triggerPrefix = 'sp_sync_' . substr(hash('sha256', $table), 0, 12);
        foreach (['INSERT','UPDATE','DELETE'] as $event) {
            $trigger = $triggerPrefix . '_' . strtolower($event);
            $db->exec('CREATE TEMP TRIGGER IF NOT EXISTS "' . $trigger . '" AFTER ' . $event . ' ON main.' . $quotedTable . ' BEGIN UPDATE sp_sync_marker SET changed=1; END');
        }
    }
}

function registration_roster_track_api_changes(PDO $db): void {
    registration_roster_install_change_tracking($db);
    register_shutdown_function(static function() use ($db): void {
        try {
            if ($db->inTransaction()) return;
            if ((int)$db->query('SELECT changed FROM temp.sp_sync_marker LIMIT 1')->fetchColumn() !== 1) return;
            registration_roster_sync($db);
        } catch (Throwable $error) {
            error_log('Automatic OneDrive database sync could not complete: ' . $error->getMessage());
        }
    });
}

function registration_roster_sync(PDO $db): array {
    if (getenv('SP_ONEDRIVE_ROSTER_SYNC') === '0') {
        return array_merge(registration_roster_status(), ['error' => 'OneDrive database sync is disabled in this test environment.']);
    }

    $lockKey = hash('sha256', realpath(DATA) ?: DATA);
    $lock = @fopen(sys_get_temp_dir() . '/smart-police-onedrive-' . $lockKey . '.lock', 'c');
    if (!is_resource($lock) || !flock($lock, LOCK_EX)) {
        if (is_resource($lock)) fclose($lock);
        return registration_roster_save_failure(registration_roster_status(), 'Could not start a safe OneDrive database sync. Retry from Admin Settings.');
    }
    try {
        return registration_roster_sync_locked($db);
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

function registration_roster_save_failure(array $previous, string $error): array {
    $status = [
        'schema_version' => (int)($previous['schema_version'] ?? 0),
        'synced' => false,
        'last_sync' => $previous['last_sync'] ?? null,
        'row_count' => max(0, (int)($previous['row_count'] ?? 0)),
        'sheet_count' => max(0, (int)($previous['sheet_count'] ?? 0)),
        'web_url' => registration_roster_web_url($previous['web_url'] ?? null),
        'error' => mb_substr($error, 0, 300),
    ];
    try { registration_roster_save_status($status); }
    catch (Throwable $failure) { error_log('OneDrive database sync failed and its status could not be saved.'); }
    error_log('OneDrive database workbook sync failed: ' . $error);
    return $status;
}

function registration_roster_sync_locked(PDO $db): array {
    $previous = registration_roster_status();
    $error = null;
    try {
        $sheets = registration_roster_export_sheets($db);
        $recordCount = array_sum(array_map(static fn(array $sheet): int => count($sheet['rows']), $sheets));
        $payload = json_encode(['sheets' => $sheets], JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
        if (strlen($payload) > 32 * 1024 * 1024) $error = 'The database workbook is too large to upload in one update.';
    } catch (Throwable $failure) {
        error_log('OneDrive database workbook could not be prepared: ' . $failure->getMessage());
        $error = 'The database workbook could not be prepared. Check the application logs and retry.';
    }
    if ($error === null && !function_exists('proc_open')) {
        $error = 'This server cannot start the OneDrive sync process.';
    }
    if ($error === null) {
        $descriptors = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        $process = @proc_open(['node', __DIR__ . '/../scripts/onedrive-registration-roster.mjs'], $descriptors, $pipes, dirname(__DIR__), null, ['bypass_shell' => true]);
        if (!is_resource($process)) {
            $error = 'Could not start the OneDrive sync process.';
        } else {
            $offset = 0; $length = strlen($payload);
            while ($offset < $length) {
                $written = @fwrite($pipes[0], substr($payload, $offset));
                if ($written === false || $written === 0) break;
                $offset += $written;
            }
            fclose($pipes[0]);
            $stdout = (string)stream_get_contents($pipes[1]); fclose($pipes[1]);
            $stderr = (string)stream_get_contents($pipes[2]); fclose($pipes[2]);
            $exitCode = proc_close($process);
            $result = json_decode($stdout, true);
            if ($offset !== $length) {
                $error = 'The OneDrive sync process did not receive the full database snapshot.';
            } elseif ($exitCode !== 0 || !is_array($result) || !registration_roster_web_url($result['webUrl'] ?? null)) {
                $error = trim($stderr) ?: 'OneDrive could not update the database workbook.';
                $error = mb_substr($error, 0, 300);
            } else {
                $status = [
                    'schema_version' => 2,
                    'synced' => true,
                    'last_sync' => time(),
                    'row_count' => $recordCount,
                    'sheet_count' => count($sheets),
                    'web_url' => registration_roster_web_url($result['webUrl']),
                    'error' => null,
                ];
                try { registration_roster_save_status($status); }
                catch (Throwable $failure) { error_log('OneDrive database workbook updated, but local sync status could not be saved.'); }
                return $status;
            }
        }
    }

    return registration_roster_save_failure($previous, (string)$error);
}
