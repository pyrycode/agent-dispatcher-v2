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

### Configuration loading (#3)

- `src/config/env.ts` is the single source of truth for env vars. Downstream modules consume the typed `Config` via constructor injection — no `process.env` reads outside this file.
- Pattern: pure `parseConfig(env)` core + thin `loadConfig({ agentsRoot })` I/O wrapper. Same shape as `paths/` resolvers — branch tests target the pure function.
- **Empty-string env values are treated as unset** in BOTH `.env` AND `process.env`. The `loadConfig` merge filters empties out of `process.env` before layering, so an explicit `KEY=""` in the launcher's shell does not silently nuke `.env` values.
- **`process.env` overrides `.env`** for any key with a non-empty value (CI / test harness can inject overrides). `.env` provides the developer's local defaults.
- **`GITHUB_TOKEN` value never appears in error messages** — module only validates non-empty (no shape check) so no error path can echo it. Lock-in test in `test/config/env.test.ts` (`token redaction` describe block) is the canary; any future shape-validation must preserve this.
- Returned `Config` is `Object.freeze`d (runtime guard) plus every field is `readonly` (compile-time guard). `salvageGates` is a frozen `readonly string[]`.
- `SALVAGE_GATES` defaults to `[]` (salvage opt-in) — see [ADR 0002](knowledge/decisions/0002-salvage-gates-default-empty.md).

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

### Transition table (#24)

- `src/pipeline/transitions.ts` is **data only** — no functions, no logic. Three exported types (`Column`, `Label`, `LabelPattern`, plus `Transition`) and two exported constants (`COLUMNS`, `TRANSITIONS`). Consumers (`decideLabelDelta` in #5, rework routing in #7) import directly; no `src/index.ts` re-export.
- `Label` and `LabelPattern` are intentionally narrow per the #6 narrow-types rule — only labels that some transition's `requires` actually consumes are members. `wip:*`, `error:*`, `size:*`, `priority:*`, `security-sensitive` are dispatcher-run lifecycle / metadata, not transition triggers, and stay out until a transition consumes one. Widen at that point, not preemptively.
- `LabelPattern` (`"ready:*"`, `"needs-rework:*"`) is a closed set with the same narrow-types rule: only patterns whose underlying labels can actually gate a transition belong here. The dead-letter test (`strips` patterns must match a label produced by some `requires`) is what enforces it.
- **Same-column rework rows are deliberate, not bugs.** `In Architecture → In Architecture` (and the developer / code-review variants) appear because the column doesn't change but the labels do, and `decideLabelDelta` is the only place labels mutate. Without these rows, #5 would have to special-case label-only transitions outside the table.
- **`Inbox → Backlog` row has empty `requires`.** It's a manual human-triage move. Without it the reachability test fails for every column except Inbox, since nothing else routes out of Inbox.
- Forward auto-advance rows have empty `strips` (matches v1's `runAutoAdvance` "no strip" semantics). Done + rework rows strip `ready:*` + `needs-rework:*` so the target re-runs on a clean slate.
- Three invariant tests in `test/pipeline/transitions.test.ts` are the verification: reachability from Inbox, `from`/`to` membership in `Column`, and no dead-letter `strips` patterns. There's no integration target — consumers land in their own tickets and get behavioral tests there.
- No `needs-rework:documentation` row(s) yet — no observed transition routes back into documentation as a rework target. If a future ticket needs it, widen the `Label` union and add the row.

## Open follow-ups

- Add `"packageManager": "pnpm@x.y.z"` to `package.json` as the single source of truth for pnpm version, then drop the workflow's `version: 9`. Deferred from #1 because that ticket forbade new pins to `package.json`.
