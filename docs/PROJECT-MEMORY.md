# PROJECT-MEMORY

Evergreen project state for `agent-dispatcher-v2`. Updated as tickets land. Per-ticket implementation summaries live in [`knowledge/codebase/`](knowledge/codebase/) — one file per ticket; **do not** maintain a "What's Built" list here.

## Where things live

- `docs/specs/architecture/<ticket>-<slug>.md` — architect specs (one per ticket).
- `docs/knowledge/codebase/<ticket>.md` — implementation summary, one per ticket.
- `docs/knowledge/features/` — evergreen feature docs.
- `docs/knowledge/decisions/` — ADRs, numbered sequentially.
- `docs/knowledge/architecture/` — system-level design (seeded on the first `src/` ticket).
- `docs/knowledge/INDEX.md` — one-line summaries of `features/`, `decisions/`, `architecture/`.
- `docs/lessons.md` — gotchas accumulated across tickets.

## Patterns established

### CI plumbing (#1)

- Single workflow file at `.github/workflows/ci.yml`. One job, one OS (`ubuntu-latest`), one Node major (22). No matrix unless explicitly required.
- Four steps in order, each its own `- run:`: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm lint`. Don't chain with `&&` — named step boundaries surface failures cleanly.
- `pnpm/action-setup@v4` runs **before** `actions/setup-node@v4`. setup-node's `cache: 'pnpm'` invokes pnpm to resolve the store path; reversing the order produces "pnpm: command not found".
- Node version comes from `package.json#engines.node` via `node-version-file: 'package.json'`. pnpm version is pinned in the workflow YAML (`version: 9`) — see [ADR 0001](knowledge/decisions/0001-pnpm-version-in-workflow.md).
- `concurrency` cancels superseded runs on the same ref. `permissions: contents: read` only.
- New CI checks are added as a new `- run:` step. Don't bundle into existing steps.

## Open follow-ups

- Add `"packageManager": "pnpm@x.y.z"` to `package.json` as the single source of truth for pnpm version, then drop the workflow's `version: 9`. Deferred from #1 because that ticket forbade new pins to `package.json`.
