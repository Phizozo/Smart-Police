# Smart Police

Three interfaces in one browser app: **Citizen**, **Officer** and **Admin**.
PHP 8.4+ (pdo_sqlite, openssl, mbstring), Composer, SQLite, C++17, vanilla JS/CSS.
Node.js 24+ and npm are required for the local PDF viewer and server-side stamped approval PDFs. The start scripts install locked dependencies if missing; the application server remains PHP.

See [Citizen dashboard and identity-document requests](docs/citizen-services.md) for affidavit/certification forms, Officer review, privacy boundaries, and PDF records.

## Start (easiest)
- **Windows:** double-click `start.bat` (or run `start.bat 8080`).
- **Linux / macOS / WSL:** `./start.sh` (or `./start.sh 8080`).

On Linux/macOS/WSL, the default is **http://localhost:5000**; use the port you passed if different. Replit uses the running preview. Keep the terminal window open; closing it stops the site.

## First run and accounts
There are no built-in or demo passwords. The first time you open the site it asks you to **create the administrator**: type your own name, a unique `@admin.co.za` email and a password of **5–8 characters**. The same limit applies whenever anyone signs in or creates/changes an account password. Complete initial setup before sharing the site.

- **Citizen**, **Officer** and **Admin** have separate signup and login portals. Usernames are unique across the system; an account can sign in only through its assigned role.
- **Usernames** can be 1–80 characters, including spaces, uppercase letters, punctuation and Unicode. Blank usernames, control characters and duplicates are rejected.
- **Citizens** can create their own accounts and sign in immediately; they do not need Admin approval. **Officer/Admin** self-signups stay pending until an administrator approves them. Rejected requests cannot sign in.
- Citizen signup requires a residential address, a South African phone number entered as 9 digits after the displayed `+27` prefix, a valid `@gmail.com` email, consent, and a live-camera photo capture. The photo is encrypted in the app and can be viewed by Admins and Officers authorized for a related service request; it is not copied to OneDrive or used for automatic face matching.
- Admin signup, initial administrator setup and admin-created administrator accounts require a unique `@admin.co.za` email. **Manage users** lists full names and available email addresses. Citizen and Officer accounts do not require an Admin-domain email.
- **Admin** can create active Officer/Administrator accounts directly under **Manage users** (including at least two additional Admin accounts), review pending requests, oversee cases and evidence, and reset other users' passwords. Admin can suspend Officers with a required reason; suspension blocks sign-in and revokes an existing session on its next request. The suspension reason remains in the account and audit history. Admin SOS Coordination is not shown as a tab; Officers retain their SOS tools.
- Citizen password sign-in requires opening **Face Recognition**, starting the camera, and pressing **Capture**. The image is sent with sign-in, validated as an image, and discarded without persistent storage; it is not automated face detection or identity verification. Passwords and any enabled device-passkey second step remain required. A capture cannot establish that the pictured person owns the account.
- Everyone can change their own password with **Change password** in the top bar.
The **Forgot password?** link explains the safe recovery path: an administrator resets the account under **Manage users**; it does not send an unverified password-reset email.

Passwords are stored salted and hashed (bcrypt), never in plain text. The user-selected **5–8 character** rule applies to every account password, including login and password changes. Older accounts with passwords longer than eight characters cannot sign in until an admin resets them; an admin can reset other users under **Manage users**. The current administrator can change their own password. This short limit is less protective than allowing longer passwords. Login attempts are limited after five failures for a username within ten minutes. Sessions expire after 30 minutes without an explicit authenticated action and after 12 hours regardless of activity; background polling does not keep them alive. Changing a password invalidates the user's other sessions. Backup passphrases are separate and remain 16–1,024 bytes.
Use the encrypted recovery process for maintenance; deleting `data/` destroys accounts, case records and encryption keys.

## PHP setup
PHP must be on your PATH, with `pdo_sqlite`, `openssl` and `mbstring` enabled (in php.ini remove the `;` before those `extension=` lines). Ubuntu: `sudo apt install php-cli php-sqlite3 php-mbstring g++ make`.
Run `composer install --no-interaction --prefer-dist` to install the locked WebAuthn dependencies. The Linux start script does this automatically when `vendor/autoload.php` is absent. Passkeys are tied to the website domain, and device prompts should be used from an HTTPS top-level browser tab rather than an embedded preview.

## The C++ stamper
`bin/stamper` (Linux) and `bin/stamper.exe` (Windows) are included prebuilt and write the stamped PDF. The Linux start script rebuilds it if g++ is available. If the binary is missing or will not run, the app falls back to an equivalent PHP writer, so certification still works; the audit log records which one was used.

## Where each requirement lives
- Salted, hashed passwords: `password_hash()` (bcrypt, per-user salt), `public/api.php`.
- Files encrypted at rest: AES-256-GCM in `src/lib.php`. Key: `data/master.key`.
- Role-based access: `need([...roles])` on every action; `case_for()` scopes all case data.
- Admin single-session lock: `admin_lock` table, 45 s heartbeat.
- Audit log: `audit()` records user, action, detail, IP and browser.
- Real time: the browser polls every 3 s; officers get a banner and beep on new SOS.
- SOS: browser Geolocation, location re-sent every 8 s while the alert is open.

## Encrypted recovery backups
Administrators can create a passphrase-protected full recovery archive under
**Settings**. Unlike PDF snapshots, it includes SQLite, all evidence, original
and stamped affidavits, saved PDFs and the encryption key. PHP `sodium` is required.
See [the backup and recovery guide](docs/backup-recovery.md) for verification,
offline restore, recovery drills and the explicit retention/deletion policy.
Do not store archives in the project or commit them to Git.

## Modules and reports
- **Case Management:** citizen incident forms, officer assignment/status updates, evidence review, affidavits and timestamped PDF downloads.
- **SOS Coordination:** citizen alerts, optional live GPS, staff response/resolution and maps.
- **Administration:** an oversight dashboard with alerts, system counts and recent portal activity; case/evidence management; user approval and multi-admin account creation; operational reports; sync and backup settings.

Admin → Operational reports offers five reports, each in PDF and CSV:
case register, case status summary, officer workload, SOS alert register and
security audit. Optional date filters use inclusive Johannesburg calendar dates.
They read all matching database rows, not just the case list's display limit.
Generated report PDFs, full record PDFs and settings/sync PDFs are retained in
the protected PDF archive under **Settings** and are included in recovery backups.
The dashboard refreshes system data every three seconds while open.
PDF reports are saved encrypted in the vault; CSV downloads are not recovery archives.

## Validation
`bash scripts/post-merge.sh` checks PHP syntax, compiles the stamper as needed,
and runs isolated API, backup/recovery, validation, database-integrity, security
and report checks. `node tests/ui_smoke.mjs` additionally checks real browser
forms and navigation; it requires Node 22+ and Chromium. All automated tests use
temporary storage, never working case files or accounts.

## Before production
Use HTTPS (browsers need it for GPS off localhost); HTTPS requests get Secure cookies, alongside HttpOnly and SameSite=Strict. Keep `data/` outside the served `public/` directory and use encrypted recovery archives for backups. Affidavit submissions are plain text only; certification generates a PDF. Configure production hosting, upload limits, trusted proxy headers, durable protected storage and security/legal review before using real sensitive case data.
