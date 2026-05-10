# PROJECT-MEMORY

Evergreen project state for `agent-dispatcher-v2`. Updated as tickets land. Per-ticket implementation summaries live in [`knowledge/codebase/`](knowledge/codebase/) — one file per ticket; **do not** maintain a "What's Built" list here.

## Where things live

- `docs/specs/architecture/<ticket>-<slug>.md` — architect specs (one per ticket).
- `docs/knowledge/codebase/<ticket>.md` — implementation summary, one per ticket.
- `docs/knowledge/features/` — evergreen feature docs.
- `docs/knowledge/decisions/` — ADRs, numbered sequentially.
- `docs/knowledge/architecture/` — system-level design (seed when cross-cutting prose is warranted; module-local context lives in per-ticket summaries).
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

- `src/pipeline/transitions.ts` is **data only** — no functions, no logic. Four exported types (`Column`, `Label`, `LabelPattern`, `Transition`) and two exported constants (`COLUMNS`, `TRANSITIONS`). Consumers (`decideLabelDelta` in #5, rework routing in #7) import directly; no `src/index.ts` re-export.
- `Label` and `LabelPattern` are intentionally narrow per the #6 narrow-types rule — only labels that some transition's `requires` actually consumes are members. `wip:*`, `error:*`, `size:*`, `priority:*`, `security-sensitive` are dispatcher-run lifecycle / metadata, not transition triggers, and stay out until a transition consumes one. Widen at that point, not preemptively.
- `LabelPattern` (`"ready:*"`, `"needs-rework:*"`) is a closed set with the same narrow-types rule: only patterns whose underlying labels can actually gate a transition belong here. The dead-letter test (`strips` patterns must match a label produced by some `requires`) is what enforces it.
- **Same-column rework rows are deliberate, not bugs.** `In Architecture → In Architecture` (and the developer / code-review variants) appear because the column doesn't change but the labels do, and `decideLabelDelta` is the only place labels mutate. Without these rows, #5 would have to special-case label-only transitions outside the table.
- **`Inbox → Backlog` row has empty `requires`.** It's a manual human-triage move. Without it the reachability test fails for every column except Inbox, since nothing else routes out of Inbox.
- Forward auto-advance rows have empty `strips` (matches v1's `runAutoAdvance` "no strip" semantics). Done + rework rows strip `ready:*` + `needs-rework:*` so the target re-runs on a clean slate.
- Three invariant tests in `test/pipeline/transitions.test.ts` are the verification: reachability from Inbox, `from`/`to` membership in `Column`, and no dead-letter `strips` patterns. There's no integration target — consumers land in their own tickets and get behavioral tests there.
- No `needs-rework:documentation` row(s) yet — no observed transition routes back into documentation as a rework target. If a future ticket needs it, widen the `Label` union and add the row.

### src/github/ I/O surface (#19)

- `src/github/` is the I/O edge for GitHub Projects v2. `project-client.ts` is the single initialization surface; sibling files (`issues.ts` in #20, `labels.ts` in #21) and the loop will receive a `GitHubProjectClient` via DI rather than reaching for a global. No file under `src/pipeline/` may import from `src/github/` — that direction is the seam between pure decisions and live state.
- **Static factory + private constructor.** `GitHubProjectClient.initialize(opts, transport)` is the only entry point; the constructor is private. The factory resolves project ID + Status field ID + Status option IDs up front so methods can rely on the cached state without `if (!projectId) throw "Not initialized"` defensive guards. Mirrors the `parseConfig` / `loadConfig` split — the wrapper makes a precondition unfakable.
- **Transport is dependency-injected as a callable.** `type GraphQLTransport = (query, variables) => Promise<unknown>` mirrors `@octokit/graphql`'s exported callable shape. Production wiring (later ticket) is one line: `graphql.defaults({ headers: ... })`. Tests hand-roll a routing-table function — no mock library, no inheritance, no `as any`. The `calls` log is the verification mechanism for "transport receives the right query".
- **No `@octokit/graphql` runtime dep here.** The transport is interface-shaped; the launcher decides on the implementation. Adding the dep happens only when the production transport lands — keeps this module zero-dep, the integration tests zero-network, and a future swap (e.g. to `gh api graphql`) costless.
- **Org-aware dispatch is explicit; NO try/catch fallback.** `ownerType === "organization"` interpolates `organization(login:)`; `"user"` interpolates `user(login:)`. A mismatched `ownerType` propagates the GraphQL error verbatim — wrapping it in a `try { /* org */ } catch { /* user */ }` fallback would mask every auth / rate-limit / transient failure as "wrong owner type". Test #3 locks both the verbatim message AND `transport.calls.length === 1`.
- **Native ordering, never derived from `issueNumber`.** Items are fetched via `orderBy: { field: POSITION, direction: ASC }`; the result array is returned in transport order. Sorting client-side by `issueNumber` would put split-children out of order (PO inserts at the top, lower numbers naturally) and break the dispatcher's "drag to prioritize" affordance. Test #4 has a `.not.toEqual([10, 20, 30, 50])` regression guard against any future "sort for test stability" simplification.
- **`ProjectItem` is intentionally narrow** — `id`, `issueNumber`, `title`, `status`, `labels`, `url`. Per the #6 narrow-types rule, do NOT widen for hypothetical future consumers. Sibling tickets (#20 issues, #21 labels) widen at the moment they need a field.
- **`status` is a `string` with `"no-status"` sentinel** when `fieldValueByName` is null. Keeps consumer types simple (`string`, not `string | null`) and matches v1. Boards with un-statused items still list cleanly.
- **Pagination is in this ticket; cap is fixed.** `MAX_PAGES = 50` (5000 items). v1 #203 was the precedent — a single `items(first: 100)` truncated boards past 100. The cap is the regression guard against the next variant (echoed `endCursor`, broken `hasNextPage`); it throws with a message that names the failure mode rather than silently consuming the GraphQL budget.
- **Per-cycle items cache + rate-limit tracking are NOT here.** Both observed in v1 but layered at the loop boundary — caching conflates I/O with policy, rate-limit tracking belongs where the loop's per-cycle budget is. Add a caching adapter when the loop module lands; add rate-limit tracking when budget pressure is observed.
- **GraphQL queries are minified single-line strings.** Multi-line indented queries pushed the file past the 200-line hardcap. They're opaque to the rest of the system; readability lives in the test fixtures and the surrounding comments.

## Open follow-ups

- Add `"packageManager": "pnpm@x.y.z"` to `package.json` as the single source of truth for pnpm version, then drop the workflow's `version: 9`. Deferred from #1 because that ticket forbade new pins to `package.json`.
