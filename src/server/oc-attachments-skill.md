---
name: oc-attachments
description: Files attached in the chat — images, PDFs, documents — are saved to .opencode/attachments/<session-id>/ in the project root before the turn starts. Use whenever the user asks to reuse, embed, or reference a file they attached in chat — in a note, doc, or vault — or asks where an attached file ended up.
---

Files the user attaches in the chat are snapshotted to
`.opencode/attachments/<session-id>/` in the project root; the original
filename is kept, prefixed with a timestamp. They are copies — the chat's
own attachment lives in opencode's internal store — so rename, move, or
delete them freely.

To use one in a note or doc, copy it to the target's own attachment
location and reference it there; don't link across trees.
`.opencode/attachments/` is a transfer area, not a home.
