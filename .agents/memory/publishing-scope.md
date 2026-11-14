---
name: Publishing scope
description: User-approved demonstration publishing scope and data safety limits.
---

The user chose “Demonstration with test data only” after being told local account/document storage is not durable in publishing and the app uses PHP's development server.

**Why:** They explicitly chose demonstration publishing rather than preparing the service for real users.

**How to apply:** Do not describe the published app as production-ready for sensitive Citizen information. Keep existing workspace accounts, keys and documents out of publishing. Durable storage and a production server require separate work before real use.

Publishing runtime cannot be assumed to resolve the workspace's internal npm registry.

**Why:** A failed publish repeatedly exited during startup with `ENOTFOUND package-firewall.replit.internal`, causing readiness failures.

**How to apply:** Install dependencies during publishing's build phase and start with prebuilt dependencies, without runtime downloads. A successful workspace startup does not by itself verify this boundary.

Required runtime dependencies must survive publishing exclusions, even when ignored by Git.

**Why:** Publishing reported dependencies ready during build but repeatedly exited with dependencies missing during startup while the publishing ignore file excluded node_modules. A local build-only test missed the packaging boundary.

**How to apply:** Test the retained package as well as the build. Keep dependencies in publishing, not Git; continue excluding databases, keys, vault uploads and recovery archives.
