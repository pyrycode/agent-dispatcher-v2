# PROJECT-MEMORY

Living state for the v2 dispatcher rewrite. The "What's Built" section is intentionally absent — see [knowledge/codebase/](knowledge/codebase/) (one file per ticket; the directory listing IS the index).

## Current focus

Porting v1 modules to v2's stricter shape (one concern per file, pure functions in `src/pipeline/`, I/O at the edges, hardcap 200 lines). Repo ships empty by design; each ticket lands one module.

## Patterns Established

- **Pure resolvers under `src/paths/`.** Resolution helpers are options-object pure functions: caller reads env / captures `__dirname`, passes strings in, gets a resolved string back. No `process.env`, no `await`, no `__dirname`, only `node:path`. Empty-string env counts as unset across the board (`typeof v === "string" && v.length > 0`). Established in #2.
- **Per-ticket codebase docs.** New tickets write `docs/knowledge/codebase/<ticket>.md` instead of editing a shared "What's Built" line. Eliminates the merge-conflict hot spot from incidents on 2026-05-09 and 2026-05-10. See [knowledge/codebase/README.md](knowledge/codebase/README.md).
- **ADR for any open architect call resolved during a ticket.** Numbered sequentially under [knowledge/decisions/](knowledge/decisions/).

## Next

See the agents repo's Inbox for the next ticket. Likely candidates: `src/pipeline/transitions.ts`, `src/pipeline/decisions.ts`.
