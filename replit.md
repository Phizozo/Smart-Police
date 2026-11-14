# Smart Police

## Run
- Keep the imported PHP 8.1+/SQLite/C++/vanilla JavaScript stack and directory layout.
- The **Smart Police** workflow runs `./start.sh 5000`, listening on `0.0.0.0:5000` and serving only `public/`.
- PHP requires pdo_sqlite, openssl, sodium, mbstring and iconv. The PHP 8.4 module provides these.
- The start script rebuilds the C++ stamper if necessary and a compiler is available. PHP is the equivalent fallback.
- Home is public. On first launch, choose Admin and create the first administrator; the portal preselects Admin until setup is complete. There are no demo credentials.
- The user chose separate Citizen/Officer/Admin signup and login portals. Citizen, Officer, and Admin self-signups require approval by an existing administrator before sign-in; Admins may create active staff directly.
- The user explicitly selected **5–8 characters only for every account password**, including every role's login, signup, setup, staff creation and password changes. Admins can reset other accounts to restore access for older longer passwords; self-service change covers the admin's own password. Keep encrypted-backup passphrases separate (16–1,024 bytes).
- The user requires Admin signup/setup and admin-created administrator accounts to use a unique email ending exactly in `@admin.co.za`; this requirement does not apply to Citizen/Officer accounts.
- Usernames accept 1–80 characters, including Unicode, spaces, uppercase letters, and punctuation; reject blanks, control characters, and duplicates.

## Location and timestamps
- Case/SOS state refreshes every three seconds. GPS uploads are throttled to eight seconds and continue during Open and Responding alerts, stopping on resolution or sign-out.
- Location sharing requires HTTPS and browser permission; maps use OpenStreetMap. Loading a map sends its displayed coordinates to OpenStreetMap. GPS denial does not prevent sending an SOS without a location.
- Server records and PDF stamps use `Africa/Johannesburg`, including seconds and the timezone offset. Device clocks in the UI are labelled.
- This website is not connected to emergency dispatch and must not be described as a substitute for emergency services.

## Storage and PDFs
- SQLite, encrypted evidence, original/stamped affidavits and encrypted exported PDF snapshots are in `data/`, outside the served directory.
- Case PDFs are available to the case's citizen, eligible officer and admins. Full record backup PDFs are admin-only.
- PDF backups are readable snapshots, NOT database recovery archives. Admin → Reports provides independently passphrase-encrypted `.spbk` archives including SQLite, all vault files and the master key.
- Follow `docs/backup-recovery.md` for offline verify/restore and retention: daily off-site copies for 30 days, monthly recovery drill, no completed server archive retention. Stop all workers before replacing data. Never commit data, recovery workspaces, rollback copies or downloaded archives.
- Affidavit certification is an application stamp with officer, server timestamp and source SHA-256, not a PKI signature or proof of government approval.
- For isolated tests, `SMART_POLICE_DATA` can point to a temporary data directory. Never set it on the normal workflow.

## Verification
- `php -l public/api.php`, `php -l src/lib.php`, `php -l src/pdf.php`
- `python3 tests/api_smoke.py` uses an isolated temporary SQLite database/server, never the working app's accounts.
- `python3 tests/backup_recovery.py` tests encrypted recovery and failure safety in isolated storage.
- `python3 tests/security_reports.py` checks validation, five report types in PDF/CSV, database integrity, role restrictions, password policy, throttling and session revocation.
- `node tests/ui_smoke.mjs` exercises forms and navigation in a real Chromium browser with isolated storage (Node 22+ and Chromium required).
- The user's functional checklist requires a running system, validated linked forms, database persistence, system backup, 3–5 reports, login security/usability and at least two modules. Case Management and SOS Coordination cover the core modules; administration is separate.
- This uses PHP's development server for preview. Before public use with sensitive police/citizen data, production hosting, secure backups, access/security review and legal/compliance review are required.
