<?php
declare(strict_types=1);

require __DIR__ . '/../src/registration-roster.php';

$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
$db->exec(file_get_contents(__DIR__ . '/../schema.sql'));
$db->exec('CREATE TABLE pdf_exports(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,case_id INTEGER,filename TEXT NOT NULL,vault TEXT NOT NULL,sha256 TEXT NOT NULL,created INTEGER NOT NULL)');
$db->exec(file_get_contents(__DIR__ . '/../src/requests-schema.sql'));
$db->prepare('INSERT INTO users(username,name,role,pass_hash,created,email,residential_address,phone) VALUES(?,?,?,?,?,?,?,?)')
    ->execute(['syncadmin','Test Admin','admin','NEVER_EXPORT_PASSWORD_HASH',time(),'admin@admin.co.za','1 Test Street','+27821234567']);

registration_roster_install_change_tracking($db);
$db->exec("INSERT INTO admin_lock(id,session_id,user_id,last_seen) VALUES(1,'NEVER_EXPORT_SESSION',1,1)");
if ((int)$db->query('SELECT changed FROM temp.sp_sync_marker')->fetchColumn() !== 0) {
    throw new RuntimeException('Admin session state must not trigger a database workbook sync.');
}
$db->prepare("INSERT INTO cases(citizen_id,title,type,description,location,created,updated) VALUES(?,?,?,?,?,?,?)")
    ->execute([1,'Test case','Theft','Test description','Test location',time(),time()]);
if ((int)$db->query('SELECT changed FROM temp.sp_sync_marker')->fetchColumn() !== 1) {
    throw new RuntimeException('Operational table changes must trigger a database workbook sync.');
}

$sheets = registration_roster_export_sheets($db);
$names = array_column($sheets, 'name');
$expected = ['Users','Cases','Case events','Evidence','Affidavits','SOS','Audit','PDF exports','Service requests','Request files'];
if ($names !== $expected) throw new RuntimeException('The Excel copy must contain every operational worksheet.');
$serialized = json_encode($sheets, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
foreach (['NEVER_EXPORT_PASSWORD_HASH','NEVER_EXPORT_SESSION','pass_hash','passkey_credential','admin_setup_hash','vault','sha256','suspended_by'] as $forbidden) {
    if (str_contains($serialized, $forbidden)) throw new RuntimeException('A secret or private vault reference entered the workbook export.');
}
$users = $sheets[0];
if (count($users['rows']) !== 1 || !in_array('Residential address', $users['headers'], true) ||
    !in_array('Phone', $users['headers'], true) || !str_contains($serialized, 'admin@admin.co.za')) {
    throw new RuntimeException('The database workbook is missing the requested operational account records.');
}

echo "PASS: all operational tables are included, changes are tracked, and credentials/private file references are excluded.\n";
