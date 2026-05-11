# PROJECT-MEMORY

Evergreen project state for `agent-dispatcher-v2`. Per-ticket implementation summaries (including patterns established) live in [`knowledge/codebase/`](knowledge/codebase/) — one file per ticket. **This file is read-only for agents.** It records the project-level conventions humans maintain by hand; per-ticket content has its own home.

## Where things live

- `docs/specs/architecture/<ticket>-<slug>.md` — architect specs (one per ticket).
- `docs/knowledge/codebase/<ticket>.md` — implementation summary + patterns established, one per ticket. This is the source of truth for per-ticket knowledge.
- `docs/knowledge/features/` — evergreen feature docs.
- `docs/knowledge/decisions/` — ADRs, numbered sequentially.
- `docs/knowledge/architecture/` — system-level design (seed when cross-cutting prose is warranted; module-local context lives in per-ticket summaries).
- `docs/knowledge/INDEX.md` — one-line summaries of `features/`, `decisions/`, `architecture/`. Documentation phase is the sole writer.
- `docs/lessons.md` — **frozen 2026-05-11.** Historical reference only. New lessons go in the relevant ticket's `docs/knowledge/codebase/<N>.md` under a "Lessons learned" section.

## Write discipline

**Do not append per-ticket content to this file.** Shared-append docs cause merge conflicts when two feature branches both edit them on top of a marching-forward main (incidents 2026-05-09, 2026-05-10, 2026-05-11). Per-ticket content goes in per-ticket files; this file stays stable across cycles.

Historical note: an earlier "Patterns established" section in this file collected one entry per ticket. That section was the recurring conflict surface; it was dropped 2026-05-11 after stranding PRs #29, #49, #51. The content lives — unchanged — in `docs/knowledge/codebase/<N>.md` for each ticket.

## Open follow-ups

*Human-maintained. Agents: do not edit. File new follow-ups as GitHub issues.*

- Add `"packageManager": "pnpm@x.y.z"` to `package.json` as the single source of truth for pnpm version, then drop the workflow's `version: 9`. Deferred from #1 because that ticket forbade new pins to `package.json`.
