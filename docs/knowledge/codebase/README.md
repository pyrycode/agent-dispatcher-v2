# `codebase/` — per-ticket implementation notes

One file per ticket: `<ticket-number>.md`. Each file is the implementation summary for that ticket — what landed, where it lives, and any non-obvious shape decisions a future reader needs.

The directory listing IS the index. Don't maintain a "What's Built" section in `PROJECT-MEMORY.md`; that line was a merge-conflict hot spot when parallel docs runs both tried to prepend to it (incidents on 2026-05-09 and 2026-05-10; 5+ stuck PRs). Per-ticket files eliminate the contention entirely.

## Conventions

- Filename: ticket number only (`2.md`, `15.md`). No prefix, no slug.
- Never edit a sibling ticket's file — corrections to a prior ticket land as a new ticket.
- Keep the file short: what shipped, where, and why anything non-obvious looks the way it does. Link out to feature docs / ADRs for depth.
- Pre-2026-05-10 entries in `PROJECT-MEMORY.md` are frozen history; leave them.
