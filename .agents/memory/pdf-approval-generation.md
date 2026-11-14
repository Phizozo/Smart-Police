---
name: PDF form flattening
description: Avoid rejecting successfully flattened forms because of dangling annotation references.
---

Resolve remaining annotation references after flattening a PDF form; do not reject a page merely because its annotation array is nonempty.

**Why:** The PDF library left deleted widget references in the page's annotation array after flattening. They resolved to nothing, but counting them caused a valid filled form to be rejected.

**How to apply:** Ignore unresolved references. Continue to reject unsupported visible annotations rather than silently omitting them from a stamped document copy.
