---
name: Recovery safety
description: Security and operational decisions for complete case-file recovery
---

Keep full recovery an offline server-operator action, not an admin browser upload.
Use a backup passphrase independent of the included evidence master key, validate
in isolated staging before replacing data, and invalidate all old sessions.

**Why:** A recovery archive includes every account and the key to all case files.
Online replacement can mix active writes with restored files; surviving session
IDs can identify the wrong user after restoring an older account snapshot.

**How to apply:** Preserve these boundaries when extending recovery. Background
writers must participate in the storage lock, and operators must stop all writers
before replacement. Retention changes must cover downloaded archives, temporary
plaintext workspaces, and the rollback folder, not just completed server files.

Release both the storage lock and the PHP session lock before transferring a
finished archive to the browser.

**Why:** A slow or stalled download can otherwise block unrelated emergency
requests indefinitely even though the archive no longer depends on working data.

**How to apply:** Keep locks around snapshot creation/validation, not network
transfer. Test this with multiple PHP workers and a socket that stops reading;
a single-worker development server cannot demonstrate concurrent availability.
