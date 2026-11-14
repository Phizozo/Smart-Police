# Encrypted backup and recovery

## What is protected

**Admin → Reports → Encrypted recovery backup** downloads a `.spbk` archive
after an administrator confirms their current password and supplies a new
single-line backup passphrase twice (16–1,024 UTF-8 bytes). Keep it in a password manager
separate from the archive. There is no passphrase reset or recovery service.
Use HTTPS; archive encryption does not protect a password entered over HTTP.

The archive contains a consistent SQLite snapshot of **all tables** (including
accounts/password hashes, cases, events, SOS, audit and PDF export records),
every encrypted vault file (including evidence, original affidavit statements,
certified/stamped PDFs and saved PDF snapshots), and the 32-byte master key.
PDF/CSV downloads are not recovery archives. Do not expose any of these files
publicly. Anyone with the archive **and its passphrase** can read all its data.

The application takes an exclusive storage lock while creating a SQLite
`VACUUM INTO` snapshot and reading attachments. All API requests participate in
this lock, so backup creation briefly blocks requests, not just case writes.
It authenticates and verifies a complete trial extraction before offering the
download, then releases the storage and session locks before transferring the
finished archive. Slow/interrupted downloads do not hold up SOS or case requests
on a multi-worker server. Check the browser actually saved the file: a server download audit
event is not confirmation that the download completed on the device.

Version 1 uses libsodium XChaCha20-Poly1305 secretstream, a random 16-byte salt,
Argon2id13 (3 operations, 64 MiB memory) and a random secretstream header.
The format/version is authenticated as associated data on every frame.
An encrypted manifest lists exact file paths, lengths and SHA-256 checksums.
Frames are ordered/authenticated, and an empty final authentication frame is
mandatory; truncation, appended bytes and wrong passphrases are rejected.
The master key is inside this independently encrypted archive, **not** used as
the backup encryption key.

Requirements: PHP 8.1+ CLI/web with `sodium`, `openssl`, `pdo_sqlite`, and the
normal application extensions. Maximum archive content: 20 GiB, 50,000 files;
individual vault files must not exceed 64 MiB. Web PHP time/memory limits,
reverse-proxy timeouts and browser download memory can impose lower limits.
Provision at least three times the data size as free space for snapshot,
encrypted archive and verification extraction. Test representative sizes
before relying on this for a large installation.

## Retention policy

- The application retains **no completed recovery archive** on the server.
  Private temporary snapshots, trial extractions and encrypted output are
  removed in `finally` after success, rejection or a disconnected browser.
- A killed process or host crash can prevent cleanup. Workspaces are siblings
  of the configured data folder, named `data.recovery-<random hex>`, permission
  `0700`, with sensitive files restricted to `0600`. On the next backup or
  recovery command, workspaces older than **24 hours** are removed under the
  exclusive storage lock. If no further operation runs, the operator must
  remove these within 24 hours after recovery from the crash. Stop the app
  before manually cleaning workspaces; never delete a workspace in use.
- Administrators must download a backup **daily and before planned destructive
  maintenance**, copy it to access-controlled encrypted off-site storage, keep
  daily copies for **30 days**, and delete older copies. This is an operator
  policy, not an automatic scheduler or automatic deletion of remote/browser
  copies. Clear redundant browser downloads and trash/recycle bins after
  confirming off-site storage. Keep the passphrase separately.
- Verify recovery into isolated storage **monthly**, after a passphrase change,
  and before discarding older known-good copies. If a legal evidence hold or
  approved organization policy overrides deletion, record that exception and
  restrict access; do not silently delete held evidence.
- Successful replacement retains the previous live folder as
  `data.rollback-<timestamp>-<random>`. It contains the **old master key and data**
  and must remain private. Delete it **within 24 hours after successful recovery
  checks**, unless an approved evidence hold requires it. A failed replacement
  automatically renames it back when possible. A host crash between the two
  renames can leave this folder as the only previous copy; preserve it.

Recovery workspaces/rollback folders and `data.lock` are outside `public/` and
excluded from Git and deployment. Put downloaded archives outside the project.
The application does not include uploads under `data/tmp` in a backup: those
are transient working files, not stored case attachments. Unexpected vault
paths/symlinks cause failure rather than silent omission.

## Verify without replacing anything

Use a trusted operator terminal in the project root. Do **not** put a passphrase
in command arguments, shell history, a source file, or an environment variable.
These Bash commands read it silently and pass it on standard input:

```bash
read -r -s -p 'Backup passphrase: ' backup_passphrase; printf '\n'
printf '%s' "$backup_passphrase" | php tools/restore.php verify /secure/offsite/backup.spbk
unset backup_passphrase
```

Verification extracts only allowlisted paths into private staging beside the
data directory; it never overwrites working data. It checks:

1. Encryption authentication, complete stream/final tag, bounded manifest,
   no duplicate paths/path traversal, every length and SHA-256.
2. SQLite `integrity_check`, foreign-key consistency, supported tables/columns,
   no triggers/views, and at least one administrator.
3. Every referenced attachment exists. All vault files authenticate with the
   included master key; evidence lengths, original affidavit hashes and saved
   PDF hashes match their records. Certified affidavits have a stamped file.

On failure the command exits nonzero, prints the reason and deletes staging.
Verification still needs temporary disk space and a trusted machine, since it
decrypts the master key and database. It does not alter the source archive.

## Full recovery

Recovery **replaces all working records** with the snapshot, including users,
password hashes, cases, evidence and SOS. Changes made after the snapshot will
not be in the restored system. The tool makes no attempt to merge records.

1. Notify users of maintenance and stop the configured application workflow
   and **all** other PHP workers/background writers using the same data.
   Do not restart until recovery or rollback has finished. The lock coordinates
   API access, but cannot stop an unrelated process that bypasses the API.
2. Keep a verified encrypted backup of the current state if it is accessible.
   Confirm free disk space, ownership and the intended data directory.
3. Run `verify` above. Confirm the reported snapshot date and record counts.
4. To rehearse first, set `SMART_POLICE_DATA` **only on the command** to a new
   absolute directory, with an existing private parent. Never set this override
   on the normal application workflow. For example:

   ```bash
   mkdir -m 700 /secure/rehearsal
   read -r -s -p 'Backup passphrase: ' backup_passphrase; printf '\n'
   printf '%s' "$backup_passphrase" | SMART_POLICE_DATA=/secure/rehearsal/data \
     php tools/restore.php restore /secure/offsite/backup.spbk --replace-data
   unset backup_passphrase
   ```

5. For actual recovery, omit that override to use the normal `data/`:

   ```bash
   read -r -s -p 'Backup passphrase: ' backup_passphrase; printf '\n'
   printf '%s' "$backup_passphrase" | \
     php tools/restore.php restore /secure/offsite/backup.spbk --replace-data
   unset backup_passphrase
   ```

   This performs **all verification again**, then clears the stale admin lock,
   creates a new session epoch (invalidating every prior browser session), adds
   a restore audit entry and installs staging. The old folder is first renamed
   to a private rollback sibling on the same filesystem. If installation fails,
   it attempts to restore the old directory and reports any manual action needed.
   Never ignore a nonzero exit status.
6. Start the application. All users must sign in again using credentials **as
   they were at the snapshot**. Check case counts and audit history; download
   representative evidence and stamped PDFs; inspect original affidavit text
   as staff. Check restored SOS alerts before returning to normal service:
   snapshot-era alerts may no longer represent a current emergency.
7. Make a new encrypted backup, return to normal daily retention, and delete
   the rollback copy within the policy above. Clean up the isolated rehearsal
   as sensitive data, too.

If recovery must be reversed, stop all workers again, retain the failed
restored folder for investigation, and move the reported rollback folder back
to the exact original data path on the same filesystem. If the process died
between renames and `data/` is absent, **do not launch the app and create a new
empty database**; restore the rollback folder first. A successful install
invalidates sessions; after a manual rollback, clear server-side PHP sessions
or replace `session.epoch` with a fresh 64-character random hex value before
restarting. Do not copy individual SQLite/WAL files from different snapshots.

## Automated recovery checks

Run `python3 tests/api_smoke.py` and `python3 tests/backup_recovery.py`.
They use temporary storage, not the working app's accounts or case files.
The recovery test exercises the admin endpoint, authorization/CSRF/password
checks, encrypted round trip, corruption/wrong-passphrase/truncation and unsafe
manifest rejection, missing evidence/key problems, preservation of existing
data on failure, clean-install recovery, session invalidation and restored
attachment downloads. A multi-worker HTTP check stalls and interrupts a real
download while confirming SOS creation/updates and admin requests remain available.
These tests do not verify real off-site storage retention
or a production reverse proxy.
