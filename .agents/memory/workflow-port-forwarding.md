---
name: Workflow port diagnostics
description: Distinguish PHP application startup from Replit workflow port-forwarding failures.
---

If the Start application workflow reports that port 5000 never opened while its log says PHP started on `0.0.0.0:5000`, verify the app with a temporary isolated data directory and a local HTTP request before changing application code.

**Why:** The PHP server successfully returned HTTP 200 for the homepage and API in an isolated run, while the Replit workflow still timed out waiting for port 5000.

**How to apply:** Confirm the configured workflow port and bind address, then test the server independently. If isolated requests succeed but the workflow still fails after prior retries, avoid repeated restarts or unrelated code edits; report a likely workflow forwarding problem.
