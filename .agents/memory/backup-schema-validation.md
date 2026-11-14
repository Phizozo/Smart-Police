---
name: SQLite archive schema checks
description: Preserve compatibility when backup validation compares legacy SQLite schemas.
---

When validating a SQLite backup against the current schema, compare ordered column metadata but ignore `PRAGMA table_info`'s `cid`. SQLite renumbers cids after `ALTER TABLE ... DROP COLUMN`, so a valid legacy archive can have the same columns and order with different cids.

**Why:** Legacy backup validation rejected archives after optional columns were removed because the reference schema retained gaps in its cids while SQLite renumbered the actual columns.

**How to apply:** Keep validating column order, name, type, nullability, defaults, and primary-key status; omit only `cid` from the structural comparison.
