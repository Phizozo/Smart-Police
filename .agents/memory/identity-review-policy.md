---
name: Citizen request identity checks
description: The chosen human-review policy for affidavit and document-certification identity checks.
---

Citizen signup requires explicit consent and a real-time camera capture stored encrypted with the account; existing Citizens can add or replace the photo in Account security. Admins can view it in Manage users; Admins and the Officer assigned to a related service request can view it alongside that request's submitted camera capture and evidence. Identity checks remain human review only; there is no automated face recognition or face-to-ID matching. For affidavit and document-certification requests, an assigned Officer or Admin may review documents and approve or reject the request.

**Why:** The user asked to capture and store a Citizen camera photo for Admin user management and Officer service-request review, while prior identity-review decisions require human review rather than automatic matching.

**How to apply:** Keep account photos encrypted and outside the OneDrive workbook. Expose them only to Admins and Officers authorized for the specific request, audit every view/download, and keep identity review distinct from login authentication. Do not imply the camera detects or matches identity.

Certification requests use a document-type choice, original and copy with camera capture; they do not ask for a reason or a separate identity-proof upload. Affidavit requirements remain separate.

**Why:** The user specifically removed those two fields from Citizen document certification, not from affidavits.

**How to apply:** Do not reintroduce affidavit-only requirements into certification validation or recovery checks. Preserve existing submitted records.

Electronic approval signatures use the approving person's first initial and surname, not a drawn signature or full-name-only signature.

**Why:** The user explicitly chose initial plus surname for signatures on approved affidavits and document copies.

**How to apply:** Derive the signature from the authenticated approver's name. Preserve the actual reviewer and approval timestamp; do not attribute an Admin approval to an assigned Officer or silently re-sign historical records.

Phone OTP is a presentation-only PHP simulation, with a popup displaying the test code and no SMS provider.

**Why:** The user requested a demo without Twilio. A displayed code cannot prove possession of a phone.

**How to apply:** Keep the demo explicitly labelled and separate from real authentication and phone-ownership verification. Do not let it bypass existing password/passkey protection.
