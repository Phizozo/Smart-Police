---
name: Citizen camera sign-in
description: User-approved direction for real camera-based face authentication, separate from document review.
---

The user wants Citizen “Sign in with device passkey” replaced by real-time camera face recognition and explicitly approved using a biometric verification service.

**Why:** The user chose “Set up camera face verification” after being informed about biometric processing, enrolment, consent and potential service fees.

**How to apply:** Use genuine server-verified face matching and liveness checks, with authenticated enrolment and individual Citizen consent. Do not merely rename a passkey button or grant access because a camera captured a face. Preserve existing secure sign-in until the replacement is configured and verified. Keep document-review camera captures separate; they were supplied for human review, not biometric login enrolment.

AWS may be used for Citizen camera sign-in.

**Why:** The user's latest message reversed the earlier request to avoid AWS and resumed the AWS setup direction.

**How to apply:** The previous no-AWS restriction no longer applies. Collect credentials only through the secure workspace flow, use a dedicated restricted IAM identity, and do not treat a Cognito OAuth connection as access to Rekognition Face Liveness.

For the interim Citizen experience, provide a working desktop live camera without a “demo” label.

**Why:** The user asked for a camera demonstration, then clarified, “don't label it as demo but make real time camera working on my desktop.”

**How to apply:** The later user request requires Capture before password sign-in. Send the captured frame with password sign-in, validate it as an image server-side, and discard it without persistent storage. Explain that capture does not detect or identify a face. Password and any enabled passkey still provide authentication; capture alone must never grant access.

The Citizen sign-in camera button must read “Face Recognition,” and the standalone “Use saved passkey” button must not be shown.

**Why:** The user explicitly requested those two interface changes.

**How to apply:** Preserve accurate capture-only notices. Removing the standalone passkey button does not remove the device verification used after a password for enabled two-step security.
