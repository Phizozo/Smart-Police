---
name: OneDrive database mirror
description: User's requested scope and privacy boundary for the OneDrive Excel copy.
---

Keep the existing OneDrive workbook filename, Smart_Police_Registrations.xlsx, and mirror operational SQLite records to it.

**Why:** The user explicitly asked to keep the original workbook name and emphasized that database tables must refresh every time data changes.

**How to apply:** Keep SQLite as the source of truth and refresh after app/API writes and successful offline restores. Wire any new write path to the same refresh. Exclude passwords, passkeys, session secrets, and uploaded document contents; private uploads remain for in-portal review. The workbook may contain account contact/address details, case records, and SOS coordinates. Follow the publishing-scope rule: use test data only, not real Citizen information.
