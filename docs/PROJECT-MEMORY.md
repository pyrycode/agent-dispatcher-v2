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

### src/pipeline/ purity (#6)

- Files under `src/pipeline/` are pure: no `await`, no `gh` / `git` / `fs` calls, no shared state. Inputs are POJOs supplied by callers; outputs are decisions. Tests live in `test/pipeline/<name>.test.ts` and exercise the predicate in isolation — no integration target until a `src/dispatch/` consumer lands.
- Input types are defined in the same file as the predicate (e.g. `Blocker`, `BranchState` in `blockers.ts`). They are intentionally narrow — only the fields the predicate reads. Richer GitHub shapes are narrowed at the `src/github/` boundary before being handed to the predicate. Don't widen for hypothetical future consumers.
- `shouldFlagEmptyBranch` distinguishes silent failure (`commitsAhead === 0`, no `needs-rework:*` label → flag for `error:*`) from deliberate bail (`commitsAhead === 0`, `needs-rework:*` present → label routing already handles it). The four-row ambiguity matrix in `test/pipeline/blockers.test.ts` is load-bearing — one assertion per row so a regression points at the exact failing row.
- `parseCommitsAhead` throws on malformed input rather than returning `-1` / `null` — the dispatcher catches at the I/O boundary. Use a `/^\d+$/` regex over `parseInt` to avoid silent truncation of inputs like `"5abc"`.
- `shouldProduceCommits(agent, action)` is the explicit table of which agent-runs must produce commits. Exhaustive `switch` on `AgentName` (no `default`) gives a TS error when a new agent is added — load-bearing exhaustiveness check.
- Helpers stay unexported until a second consumer appears (e.g. `hasNeedsReworkLabel`). Promoting preemptively buys nothing and adds API surface to refactor when the rule generalizes.

## Open follow-ups

- Add `"packageManager": "pnpm@x.y.z"` to `package.json` as the single source of truth for pnpm version, then drop the workflow's `version: 9`. Deferred from #1 because that ticket forbade new pins to `package.json`.
