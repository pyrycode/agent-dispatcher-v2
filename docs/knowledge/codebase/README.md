# codebase/ — per-ticket implementation summaries

One file per ticket: `<ticket-number>.md`. The directory listing IS the index — no global "What's Built" section anywhere appends to a shared file.

## Why per-ticket files

Parallel docs agents writing to a single shared "What's Built" line caused recurring merge conflicts. Per-ticket files eliminate the hot line: two concurrent docs runs never touch the same file.

## What goes in a ticket file

- Headline: what landed and where
- Key files touched (paths)
- Behavior summary (what it does, not how it was built)
- Anything a future session would need to know that isn't obvious from the code

## What does NOT go here

- Process narrative ("the architect spec'd…", "code review found…")
- Blow-by-blow of how it was built
- Information already captured in the commit message or the ticket itself

Write for a future session that has the code in front of it but no memory of this ticket.
