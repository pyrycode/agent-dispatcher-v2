# codebase/ — per-ticket implementation summaries

One file per ticket: `<ticket-number>.md`. The directory listing IS the index — no shared-append doc anywhere collects per-ticket content.

## Why per-ticket files

Parallel pipeline runs writing to a single shared file (whether the documentation phase OR an earlier phase) caused recurring merge conflicts — not just from concurrency but from stale feature branches landing on a marched-forward `main`. Incidents 2026-05-09 (5+ stuck PRs on `INDEX.md` / `PROJECT-MEMORY.md`), 2026-05-10 (#1, #2), 2026-05-11 (#9, #42, #45). Per-ticket files eliminate the hot line entirely: two cycles never touch the same file, and a stale branch's append doesn't collide with main's later appends.

## What goes in a ticket file

- Headline: what landed and where
- Key files touched (paths)
- Behavior summary (what it does, not how it was built)
- **Patterns established by this ticket** — the load-bearing design decisions, conventions, invariants. Historically these went into `PROJECT-MEMORY.md`'s "Patterns established" section; they belong here now. One ticket's patterns live in one file.
- Anything a future session would need to know that isn't obvious from the code

## What does NOT go here

- Process narrative ("the architect spec'd…", "code review found…")
- Blow-by-blow of how it was built
- Information already captured in the commit message or the ticket itself

Write for a future session that has the code in front of it but no memory of this ticket.
