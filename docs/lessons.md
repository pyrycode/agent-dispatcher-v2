# Lessons (frozen)

**Frozen 2026-05-11.** This file is historical reference only. New lessons go into the relevant ticket's `docs/knowledge/codebase/<N>.md` under a "Lessons learned" section.

The pre-2026-05-11 entries below were collected before the per-ticket file convention. They remain here unchanged so existing cross-references still resolve. Future tickets do not append here — the per-ticket file convention eliminates the shared-append conflict surface (same fix shape as `PROJECT-MEMORY.md`'s "Patterns established" section, dropped the same day).

---

## CI / GitHub Actions

### `pnpm/action-setup` must run before `actions/setup-node` (#1)

`actions/setup-node@v4`'s `cache: 'pnpm'` resolves the pnpm content-addressable store path by invoking the `pnpm` binary. The binary needs to be on `PATH`, so `pnpm/action-setup@v4` MUST run first. Reversing the order yields "pnpm: command not found" during cache key resolution — not a typecheck/test failure, a setup failure, which is easy to misread.

### pnpm lockfile version doesn't uniquely pin pnpm major (#1)

`pnpm-lock.yaml#lockfileVersion: '9.0'` is consumed by both pnpm 9 and pnpm 10. Reading it does not tell you which major to install in CI. If neither `package.json#packageManager` nor a workflow-local `version:` is set, the action picks an unpredictable default. Pin explicitly somewhere.

### `--frozen-lockfile` in CI, plain `pnpm install` locally (#1)

`--frozen-lockfile` is the standard CI guard against silent lockfile drift — it's not a new version pin, just enforcement of the existing lockfile. Use it on every CI install step. Don't add it to local dev docs; devs need to be able to add deps without a CI flag fighting them.

## Pipeline / dispatcher routing

### Empty-branch check must inspect labels, not just commit count (#6)

A naive "no commits on the branch → `error:agent`" check conflates two distinct outcomes: silent agent failure (the agent crashed / stopped without committing) and deliberate bail (the agent intentionally handed back to PO with a `needs-rework:*` label and zero commits). On 2026-05-10 this mis-routed `error:architect` onto relay #26 — the architect had deliberately bailed, and the false `error:*` label triggered a retry that the architect didn't need.

Fix encoded in `shouldFlagEmptyBranch`: flag only when `commitsAhead === 0` AND no `needs-rework:*` label is present. The label-prefix check is the disambiguator. Any future predicate that reasons about "did the agent actually do work" must consult labels for intent, not just the branch state.

### Use `/^\d+$/` over `parseInt` when parsing counts (#6)

`parseInt("5abc", 10) === 5` — silent truncation. When parsing `git rev-list --count` output (or anything that must be a non-negative integer), prefer a regex check or `Number()` + `Number.isFinite` over `parseInt`. The regression test in `test/pipeline/blockers.test.ts` pins this explicitly so a future "simplification" can't reintroduce the bug.

## GitHub REST

### `PATCH /repos/{o}/{r}/issues/{n}` has replace-set semantics on `labels` (#35)

GitHub's REST `PATCH` on an issue **replaces the full label set** with whatever array is sent — it is not a delta-merge. Two destructive failure modes follow:

1. **`labels: undefined` leakage in the request body.** `JSON.stringify({ body, labels: undefined })` serializes to `{"body":"..."}` (undefined keys are dropped), but a layer that uses a different serializer or an `Object.assign({}, patch)` could produce `labels: null` on the wire — which GitHub interprets as "set labels to empty," silently stripping every label off the issue. In `updateIssue`, build the request body conditionally (`if (patch.labels !== undefined) body.labels = patch.labels`) rather than spreading the patch — and pin it with a deep-equals assertion on the recorded request body.
2. **Truthiness checks on `patch.body` / `patch.labels`.** `if (patch.body)` treats `""` and `[]` as "not provided," dropping legitimate clear-the-field updates. Use `!== undefined`. The regression guard is a test that `updateIssue(n, { body: "" })` IS a real PATCH (one transport call, body equals `{ body: "" }`), not a no-op.

The same shape rule generalizes to any future REST PATCH wrapper: conditional body assembly, `!== undefined` predicates, deep-equals assertion on the request body in tests.

### `removeLabel` idempotency: GET-then-PUT, not DELETE-with-catch (#36)

GitHub exposes both `DELETE /repos/{o}/{r}/issues/{n}/labels/{name}` (returns 404 when the label is absent) and `PUT /repos/{o}/{r}/issues/{n}/labels` (replace-set). The first sounds like the natural fit for `removeLabel` — until you ask how the wrapper makes "already absent" idempotent.

A `DELETE` + `try { ... } catch (e) { if (e.status === 404) return; throw e; }` shape compiles, but it couples the wrapper to a transport implementation detail (the error's `status` field) that the `RestTransport` contract intentionally doesn't expose. The transport is `(method, path, body?) => Promise<unknown>`; the rejection shape is whatever the launcher's HTTP client throws. A future swap — `gh api` shell-out vs `@octokit/rest` vs `fetch` — produces structurally different errors, and the wrapper's idempotency would silently break in CI nowhere near the swap site.

GET-then-PUT-only-if-present makes idempotency fall out of a `.filter()`: read the current set, return early if the label isn't in it, otherwise PUT the filtered set. The transport stays opaque (any rejection propagates verbatim — a 401 won't be misread as "label not present"), and the test pins zero mutating calls in the absent case by registering no PUT route, so a future "always PUT for symmetry" simplification fails the suite immediately.

The cost is two calls instead of one. Acceptable: the dispatcher is single-threaded per ticket so the read/write race is not load-bearing, and the salvage flow's failure mode (silently re-dispatched salvage PR) is far worse than an extra GET.

The same shape rule generalizes: prefer "read state, decide, write" over "write speculatively, catch the typed failure" whenever the typing of the failure isn't part of the wrapper's public contract.

### Surface conflict as a typed value, not a thrown error (#41)

GitHub's `mergePullRequest` GraphQL mutation rejects with a thrown error when the target PR has merge conflicts (`"Pull Request is not mergeable: this branch has conflicts that must be resolved"`). The naive wrapper just lets that propagate — same posture as every other `src/github/` op.

That's wrong for this op. The dispatcher's auto-merge path looks like: `runAutoAdvance` flips Status to Done as soon as `ready:documentation` lands → `runAutoMerge` calls `mergePr` → if the merge fails, the loop must roll Status back from Done → In Code Review and label `error:merge-conflict` for human triage. v1 lesson 2026-05-09 evening: without rollback the dispatcher swallows the merge failure, treats the ticket as Done forever, and the PR sits unmerged.

If `mergePr` throws, every caller has to `try/catch` and substring-match the error message to decide whether to roll status back. That duplicates the classification logic across every consumer — and the consumers are exactly the places where forgetting to catch produces the silent-stuck-Done failure mode. So `mergePr` returns `{ merged: true } | { merged: false, reason: "conflict" | "other", error }` and never throws. The substring-classification (lowercase + match `"not mergeable"`, `"merge conflict"`, `"conflict"`) lives in one well-tested place; consumers branch on the discriminant.

The try/catch wraps the entire method body, not just the mutation, so resolution failures (PR not found) also surface typed. One method, one return contract — strict reading of the AC. Pre-flight resolution errors don't misroute as conflict because their message lacks any conflict token.

Two design forces pushed the substring-match over a pre-flight `pullRequest(number:N){mergeable}` query: (1) the hot path is "merge succeeds" and a pre-flight adds a round-trip on every success, and (2) the fragility against GitHub message-wording drift is bounded — a future drift breaks a test in CI, not in production. Lowercase normalization + a conservative token set covers the observed variants.

The same shape rule generalizes: when a wrapper's failure has a structured downstream consequence (rollback, alternate path, retry-with-state-change) AND the failure mode is detectable from the error shape, surface it as a typed return rather than a throw. Throws are right when the wrapper's contract is "absence of error means success and the caller has nothing to do on failure but report"; typed results are right when the caller has work to do on each failure mode and you don't want to push the discrimination logic to every consumer.

## Worktree cleanup

### "Best-effort fallback" in a destructive primitive's locator is a foot-gun (#43)

`findCollidingWorktree(porcelain, targetPath)` parses `git worktree list --porcelain` to identify the orphaned entry that's blocking a removal. The first draft included a "best-effort: if no exact match, return the first block's path" fallback — the reasoning was that the recovery should not silently give up.

The reasoning was wrong, and code review caught it (commit `d251f1c`). The first block of `git worktree list --porcelain` is conventionally the repository's main worktree. A parser miss followed by a fallback returning the first block, plumbed straight into `git worktree remove --force`, would force-remove the main repo on every miss. That's a destructive primitive being given license to guess.

The fix is shape, not heuristic: the parser is exact-match-or-null. Callers must treat `null` as "couldn't locate, do nothing more here" and the diagnostic `list --porcelain` call becomes the deepest the recovery goes on a miss. The pure-parser test pins the no-fallback contract by feeding a porcelain stub whose first block names the main repo with target unrelated, asserting `null`. A future "best-effort" simplification fails this test immediately.

The general rule: when a parser feeds a destructive operation, prefer a narrow, refusable return shape (exact match or null) over a permissive one (best guess on miss). The cost of "couldn't locate" propagating through the recovery is bounded — at worst the leak persists until human triage. The cost of an unsafe guess is unbounded — it can destroy the wrong target. Make the conservative case the easy case; force the permissive case to be added at a callsite that has real evidence to constrain the guess.

This is the same shape rule as #6's "use `/^\d+$/` over `parseInt`" lesson: prefer "throws / returns null on ambiguous input" over "silently produces a plausible-looking value." Both fail loudly upstream rather than producing a false-positive that propagates downstream into an irreversible action.

## Configuration loading

### `{...fileEnv, ...process.env}` silently nukes `.env` values on `KEY=""` exports (#3)

The spec called for a naive `{ ...fileEnv, ...process.env }` merge in `loadConfig`. The hazard: an explicit `export KEY=""` in the launcher's shell (or a CI secret that resolves to empty) overwrites a real value from `.env` with `""`, which `parseConfig` then sees as "unset" — producing either a "missing required" throw or a silent fallback to a default, *despite the value being correctly set in `.env`*.

Fix: filter empty strings out of `process.env` *before* merging. Empty in `process.env` reads as "no opinion, defer to `.env`," matching the empty-string-as-unset convention already used inside `parseConfig`. The deviation from the spec is intentional and called out in a comment on `loadConfig`. Any future tweak to the merge logic must preserve this filter; without it, a CI run with a stray empty export will fail in a way that's hard to diagnose because the `.env` file *looks* correct.
