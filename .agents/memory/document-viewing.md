---
name: Private document viewing
description: Why document review uses the portal rather than the connected OneDrive account.
---

Keep document viewing inside the Officer portal without copying uploaded identity documents or photos to OneDrive.

**Why:** After connecting OneDrive, the user chose “View inside portal” when told that the connected personal account does not support Microsoft's embedded previews and that private OneDrive links would require separate Microsoft sign-in and file permissions.

**How to apply:** Preserve existing record-level staff permissions and authenticated original downloads. Do not treat the connected OneDrive account as permission to automatically sync private uploads or create public sharing links.

Do not solve PDF preview problems by embedding uploaded PDFs in an unsandboxed same-origin frame.

**Why:** Chrome's native PDF viewer was blocked in the sandboxed frame during real browser checks. The local page renderer avoids weakening isolation or sending sensitive PDFs to an external viewer.

**How to apply:** Verify actual rendered PDF content, not merely the presence of an iframe or a successful HTTP response.
