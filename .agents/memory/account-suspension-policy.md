---
name: Account suspension safety
description: Role coverage, required reasons and session safety for administrative suspensions.
---

Manage users supports suspending Officers, added Admins and Citizens with a required reason, and reinstating their accounts without deleting their records.

**Why:** The user requested suspension buttons and a reason box for all three roles.

**How to apply:** Keep role coverage and recorded reasons when changing account management. Suspension history must remain available after reinstatement.

An Admin cannot suspend their own account or leave the system without an activated, unsuspended Admin.

**Why:** Account management must not lock all administrators out.

**How to apply:** Enforce these protections on the server as well as in the interface.

Reinstatement must not revive sessions or pending sign-in challenges created before a suspension.

**Why:** A user may not make any requests while suspended; checking only their current suspended flag would allow old access to return automatically.

**How to apply:** Include the suspension generation in session and pending passkey challenge validation, including any new authentication paths.
