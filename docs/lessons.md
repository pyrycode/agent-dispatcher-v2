# Lessons

Gotchas surfaced during implementation. Append-only; don't rewrite history.

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

## Configuration loading

### `{...fileEnv, ...process.env}` silently nukes `.env` values on `KEY=""` exports (#3)

The spec called for a naive `{ ...fileEnv, ...process.env }` merge in `loadConfig`. The hazard: an explicit `export KEY=""` in the launcher's shell (or a CI secret that resolves to empty) overwrites a real value from `.env` with `""`, which `parseConfig` then sees as "unset" — producing either a "missing required" throw or a silent fallback to a default, *despite the value being correctly set in `.env`*.

Fix: filter empty strings out of `process.env` *before* merging. Empty in `process.env` reads as "no opinion, defer to `.env`," matching the empty-string-as-unset convention already used inside `parseConfig`. The deviation from the spec is intentional and called out in a comment on `loadConfig`. Any future tweak to the merge logic must preserve this filter; without it, a CI run with a stray empty export will fail in a way that's hard to diagnose because the `.env` file *looks* correct.
