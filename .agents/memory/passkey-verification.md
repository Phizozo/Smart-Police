---
name: Passkey verification boundaries
description: Citizen two-step method choice and limits of browser-emulated biometric verification.
---

Verify WebAuthn registration and sign-in with a browser virtual authenticator, including rejection of invalid assertions. Do not treat that as verification of physical Face ID, camera recognition, or a particular device's biometric prompt.

**Why:** Native device prompts are outside the application and browser automation. A correct WebAuthn ceremony does not establish which biometric or screen-lock method the device will offer.

**How to apply:** Describe the feature as device passkeys with biometrics when supported. Keep physical-device availability separate from automated ceremony verification, and use a top-level HTTPS tab when an embedded preview blocks credential prompts.

Citizen two-step verification uses a password followed by a device passkey, not authenticator app codes.

**Why:** The user explicitly selected password plus device passkey.

**How to apply:** Keep this method when extending Citizen account security; ask before replacing it with another verification method.

Citizen signup must not offer “Create a passkey now”; Account security remains available for later Two-step verification setup.

**Why:** The user subsequently requested removing the passkey creation option from Citizen signup.

**How to apply:** Keep signup simple without passkey enrollment prompts. Preserve password-plus-passkey setup within Account security.

Citizen Account security should show only Two-step verification, not a separate device-passkey setup or replacement panel.

**Why:** The user requested removing “Set up device passkey” and keeping Two-step verification with face verification.

**How to apply:** Create and verify a passkey within the enable-two-step flow when needed. Describe Face ID as device-dependent, not guaranteed camera-based face recognition.

Security verification and its retry messages must survive background portal refreshes.

**Why:** First-time credential enrollment changes account state before the final verification finishes; a live refresh can replace the form and erase its pending operation or error.

**How to apply:** Hold background rendering during the security operation and preserve failed form state until retry or navigation. Explicit successful refreshes may replace the form.

An already visible “Passkey enabled” status is not a completion signal for a later replacement ceremony.

**Why:** Signup can already enable the passkey before a subsequent enrollment test starts; waiting on the existing status permits sign-out while the new ceremony is still pending.

**How to apply:** When testing replacement, await evidence of that specific replacement completing before continuing to sign-out or sign-in checks.
