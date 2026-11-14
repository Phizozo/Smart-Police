# Citizen services

Citizens land on a dashboard with actual database totals, crime and service submission history, an emergency SOS button, and an opt-in location map.

Dashboard location runs only on the current device while that dashboard is active. It is not sent to Smart Police and never creates an SOS. Loading the map shares the displayed coordinates with OpenStreetMap. SOS is a separate explicit action, and an alert can still be sent if GPS is denied or unavailable.

## Requests

Citizen signup includes an explicit-consent live-camera capture. Existing Citizens can add or replace the photo under **Account security**. The photo is encrypted in the app and shown only to Admins and Officers who can access a related service request. Admins can view available photos under **Manage users**; assigned Officers can view them on the request alongside that request's own camera capture and evidence. The app does not run automated face recognition or face-to-ID matching.

**Request affidavit** accepts an ID number, optional self-described Race, reason, statement, ID proof, and live camera capture. **Certify documents** accepts ID number, optional Race, a required document type (Identity document, Matric, Qualification, Others), live camera capture, original document, and copy of document. Certification does not require a reason or a separate identity-proof upload. Document type appears in Citizen history, staff review and newly issued PDFs; existing requests and immutable PDFs remain unchanged. The “Face recognition (real-time camera review)” control shows a live preview and captures a new JPEG for human review; it is not automated face-to-ID comparison, liveness detection, or a remote live video session. Camera permission and HTTPS are required. Camera tracks stop after capture, on navigation/signout, and when the page is hidden. ID numbers support 3–30 letters, numbers, spaces, and hyphens; no nationality, race, or identity is inferred from them.

Each file is limited to 10 MB. ID/source/copy files accept validated PDF, PNG, and JPEG files; selfies require validated PNG/JPEG images. The combined HTTP limit is 44 MB. Explicit consent is required. Binary content is checked, but there is currently no malware scanning or automated facial comparison.

ID details, account camera photos, source attachments, request selfies, receipts and approved records are encrypted at rest. Only the owner Citizen may access their request documents; Admins and the assigned Officer may view request details and photos. Unassigned Officers see a limited summary and must claim a request before accessing private details or the account photo. Account photos are not included in the OneDrive workbook; encrypted recovery archives include them with the database. Photo views and downloads are audited.

An Officer claims a pending request, reviews its files, and approves or rejects it with a note. Admin can also view files and approve or reject either pending or in-review requests without claiming them. Approval requires explicit identity and document review confirmations for both roles. The actual deciding reviewer and role are recorded; completed decisions cannot be silently overwritten. Rejected requests retain the reason; Citizens can submit a corrected new request. The Citizen SOS navigation tab is hidden; the dashboard SOS emergency button remains.

## PDFs and recovery

A submission saves an immutable receipt PDF. Approval saves a separate reviewed PDF with the actual reviewer name and role, server time in Africa/Johannesburg, a review stamp, and SHA-256 fingerprints of unchanged source files. Older saved PDFs remain unchanged. The PDF is an electronic workflow record, not a cryptographic digital signature or proof that in-person commissioning/statutory certification has taken place. Original documents must still be presented where legally required.

## Staff document viewer

Officers and Admin can use **View** alongside the existing original downloads for request attachments, request receipt/review PDFs, case evidence and case-linked affidavits. Request access still requires the assigned Officer or Admin; case evidence retains its existing case-level permissions, including the unassigned case queue. Citizen download access is unchanged and does not gain staff preview access.

PDFs render locally using PDF.js with previous/next page, zoom and fit-width controls; PNG/JPEG images and plain text display inside the portal. No native PDF plugin or third-party online viewer is used. PDF JavaScript evaluation and XFA are disabled, and page count/canvas memory have limits. Password-protected, malformed and unsupported files fail explicitly and retain **Download original**. Uploaded HTML/SVG is never rendered as an active document, and text uses text content rather than HTML. Previews are authenticated, non-cacheable, audited, and source documents remain unchanged. The viewer cancels pending loads and clears temporary content when closed, on navigation, and on sign-out/session loss.

The PDF renderer and approval PDF libraries are local npm dependencies pinned by `package-lock.json`. Install with `npm ci --omit=dev --omit=optional` (Node.js 24+). The start scripts install missing dependencies, and post-merge setup installs the current lockfile. `public/pdfjs.php` serves only allowlisted browser runtime/font/decoder assets from PDF.js, not application files; no uploaded content is written into the public directory.

## Approved Citizen downloads

The Citizen Dashboard immediately displays a labelled South Africa overview and automatically requests browser GPS permission once per dashboard visit. After consent, a live marker, accuracy and update time follow device readings. Pause/resume and retry controls are explicit; polling never overrides a pause or repeats denied permission requests. Leaving the dashboard or signing out clears the watch and in-memory point. Location is separate from SOS and is not stored in the application; OpenStreetMap receives the displayed map viewport.

New approvals create an immutable, server-generated PDF available to the Citizen who owns the request:

- **Affidavit Report:** a PDF headed exactly **Affidavit Report**, containing the full submitted statement across as many pages as needed, the review register and the approving person's electronic signature/stamp.
- **Certification:** the actual submitted **copy**, not the original or merely a receipt. Each PDF page (including rotated pages), or the PNG/JPEG image, appears above a separate stamp area. The attachment/review register follows the copy.
- The stamp includes the authenticated approver's full name and role, electronic signature in **first initial + surname** format, reference, source SHA-256 fingerprint and server approval date/time in Africa/Johannesburg. Re-downloading does not change the approval timestamp or signature. An Admin approval identifies the Admin, never a different assigned Officer.
- Source uploads and receipts remain unchanged and encrypted. Existing approvals retain their historical PDFs and are labelled **legacy** review records rather than silently re-signed. Pending/rejected requests have no approved-result download.
- This is a visible electronic approval stamp, not a cryptographic certificate or a claim that remote review satisfies statutory commissioning.

Stamping runs locally via `scripts/stamp-request.mjs` using private process pipes, a 30-second deadline and bounded input/output/memory. Normal form fields are flattened so their visible values survive stamping. Dynamic XFA and remaining annotations require a flattened PDF copy; unsupported/encrypted/malformed PDFs, copies over 200 pages or images over 40 megapixels do not produce substitute PDFs or approve the request. Normal upload limits remain 10 MB per file. No OneDrive or online conversion service receives document bytes.

Verification: `node tests/stamped_documents.mjs` and `python3 tests/service_requests.py` require Poppler's `pdftotext` for assertions against actual PDF content.

The user chose this in-portal option instead of OneDrive. No documents are copied to Microsoft storage and no cloud sharing links are created.

Encrypted recovery archives include the request database rows and all referenced vault files, with content hashes validated before restoration. Older archives lacking both request tables remain supported and migrate when the app starts. Restoration remains an offline operator action.

Run `python3 tests/service_requests.py` for lifecycle, privacy, upload-validation, PDF and recovery checks. `node tests/ui_smoke.mjs` checks rendered Citizen/Officer/Admin flows and mobile layout using disposable accounts. To retain test screenshots in an ignored directory: `UI_SNAPSHOTS_DIR=generated-artifacts/citizen-services node tests/ui_smoke.mjs`.
