CREATE TABLE IF NOT EXISTS service_requests(
 id INTEGER PRIMARY KEY,
 ref TEXT UNIQUE,
 citizen_id INTEGER NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN('affidavit','certification')),
 status TEXT NOT NULL DEFAULT 'Pending review' CHECK(status IN('Pending review','In review','Approved','Rejected')),
 details_vault TEXT NOT NULL,
 details_sha256 TEXT NOT NULL,
 receipt_vault TEXT,
 receipt_sha256 TEXT,
 result_vault TEXT,
 result_sha256 TEXT,
 officer_id INTEGER REFERENCES users(id),
 note TEXT,
 identity_checked INTEGER NOT NULL DEFAULT 0 CHECK(identity_checked IN(0,1)),
 documents_checked INTEGER NOT NULL DEFAULT 0 CHECK(documents_checked IN(0,1)),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 reviewed_at INTEGER,
 reviewer_id INTEGER REFERENCES users(id),
 result_format TEXT NOT NULL DEFAULT 'review_record' CHECK(result_format IN('review_record','stamped_document'))
);
CREATE TABLE IF NOT EXISTS request_files(
 id INTEGER PRIMARY KEY,
 request_id INTEGER NOT NULL REFERENCES service_requests(id),
 kind TEXT NOT NULL CHECK(kind IN('id_proof','selfie','original','copy')),
 filename TEXT NOT NULL,
 mime TEXT NOT NULL CHECK(mime IN('application/pdf','image/jpeg','image/png')),
 size INTEGER NOT NULL,
 sha256 TEXT NOT NULL,
 vault TEXT NOT NULL,
 UNIQUE(request_id,kind)
);
CREATE INDEX IF NOT EXISTS ix_requests_citizen ON service_requests(citizen_id,created);
CREATE INDEX IF NOT EXISTS ix_requests_officer ON service_requests(officer_id,status);
