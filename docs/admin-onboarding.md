# Admin accounts and Dashboard

## Add Admins

An authenticated Admin can open **Manage users → Add Admins**, enter a full name
and an email ending in `@admin.co.za`, and select **Add account**. No username,
role selector, or initial password is entered in this form.

The system reserves an Admin account and shows a private, single-use password
setup link. Copy it and share it privately with the intended person. **No email
is sent automatically.** The link uses the origin of the website currently open;
links created in the development preview point to that preview.

The recipient follows the link, sees their assigned username, and chooses and
confirms a password of 5–8 Unicode characters. Setting the password does not sign
in or switch an existing account. They must explicitly sign in to the Admin
portal. Existing Admin session-lock rules remain unchanged.

Links expire after one hour. **Reissue setup link** on a pending Admin's row
replaces the old link. Closing the link dialog clears it from the page; use
reissue if the link was lost. Password reset also revokes an outstanding setup
link. Pending setup accounts cannot sign in and are not counted as active Admins.

## Security and recovery

Tokens are random 256-bit values in URL fragments, not URL query strings. The
setup page removes the token from the address bar. Raw tokens are not saved in
the database, audit log, or browser storage. The database retains only a hash
bound to the session/recovery epoch and an expiry time.

Creation and reissue require an Admin session and CSRF protection. Public setup
requests also require CSRF protection, limit invalid attempts, and consume the
token atomically. Setup never changes the current signed-in identity.

Older backups without setup metadata remain supported. Recovery rotates the
epoch, invalidating old pending links; an Admin must reissue them after recovery.

## Dashboard statistics

The compact status bars use complete database case-status counts, not the
limited loaded case list. Role columns use pink for Citizens, yellow for Officers,
and purple for Admins. **Crime stats** is a pie chart using complete database
incident-type totals and the same three-colour palette. Up to three nonzero types
are shown separately; with more types, the largest two and a labelled
**Remaining types** aggregate are plotted. The full original type/count breakdown
remains visible. An empty database shows an explicit empty state, not fabricated
pie slices. Graphs update through normal live synchronization and include readable
counts. There is no separate cases-by-type box or review-queue graph, and no
fabricated historical trend data.

Recent portal activity occupies a full-width panel with wrapping account names
and event descriptions. The selected Sign in or Sign up option uses darker grey,
with lighter grey for the unselected option and black text for both.
