# Spec — `src/paths/` resolvers (#2)

## Files to read first

- `agent-dispatcher/src/worktree.ts:184-263` (v1, in `~/Workspace/Projects/agent-dispatcher`) — the canonical implementations of `resolveAgentsRepoRoot`, `resolveAgentsRepoRootWithEnv`, `resolveTargetRepoRoot`. Two semantic invariants live here: `agents/` is INSIDE the target (target = parent of agents), and empty-string env is treated as unset. Don't reintroduce the bugs called out in the leading comments (`c72adb4`, `pyrycode/pyrycode/`).
- `agent-dispatcher/src/lib.test.ts:60-188` (v1) — the existing test cases for the three functions. Port the assertions verbatim where applicable; v2's test files mirror this shape.
- `agent-dispatcher/src/dispatch-bin.ts:27-89` (v1) — the call-site pattern showing where `process.env` and `__dirname` are read (entry-point file, never inside the resolvers). v2's eventual `src/dispatch/` call site mirrors this.
- `CLAUDE.md` (this repo) — "Pure functions in `src/pipeline/`, I/O at the edges" rule. `src/paths/` follows the same discipline (no `process.env`, no `await`, no shelling out, no `__dirname` capture). The "200-line hardcap, one concern per file" rule explains why this ports as two files instead of one.
- `src/index.ts` — the barrel. Confirms it's empty; new modules add exports here once landed (`export * from "./paths/agents-root.ts"` etc.) but **internal imports must NOT route through it** (CLAUDE.md "Don't import from a barrel file").
- `tsconfig.json` — `verbatimModuleSyntax: true`, `allowImportingTsExtensions: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. Type-only imports must use `import type`; relative imports use `.ts` extensions; optional fields can't be elided where the type expects an explicit `| undefined`.
- `test/scaffold.test.ts` — the existing vitest pattern (`describe` / `it` / `expect`). Mirror the import shape (`import { describe, expect, it } from "vitest"`).

## Context

v1's `dispatcher/src/worktree.ts` carries three small pure functions for path resolution: `resolveAgentsRepoRoot`, `resolveAgentsRepoRootWithEnv`, `resolveTargetRepoRoot`. v2's "one concern per file" rule says they each (or each pair) deserve their own file. This ticket ports the resolution decisions only — the I/O surfaces (`process.env` reads, `__dirname` capture from `import.meta.url`) stay at the call site (`src/dispatch/` once it lands; out of scope here).

There are no existing consumers in v2 (the repo is scaffolding-only). These two modules can land cleanly without touching anything else.

## Design

### Files

- `src/paths/agents-root.ts` — exports `resolveAgentsRoot`
- `src/paths/target-root.ts` — exports `resolveTargetRoot`
- `test/paths/agents-root.test.ts`
- `test/paths/target-root.test.ts`

No shared helper file. Each module imports `resolve` from `node:path` directly. They do not import each other.

### Signatures

```ts
// src/paths/agents-root.ts
export interface ResolveAgentsRootOpts {
  envValue: string | undefined;
  fallback: string | undefined;
}

export function resolveAgentsRoot(opts: ResolveAgentsRootOpts): string;
```

```ts
// src/paths/target-root.ts
export interface ResolveTargetRootOpts {
  envValue: string | undefined;
  agentsRoot: string | undefined;
}

export function resolveTargetRoot(opts: ResolveTargetRootOpts): string;
```

Both options are passed as a single object (mirrors v1's `resolveAgentsRepoRootWithEnv` shape, makes the call site self-documenting at the boundary).

### Resolution order

**`resolveAgentsRoot`:**
1. If `envValue` is a non-empty string → `resolve(envValue)` (normalizes `..` segments, makes absolute).
2. Else if `fallback` is a non-empty string → `resolve(fallback)`.
3. Else throw `Error("Cannot resolve agents repo root: set AGENTS_REPO_PATH or pass a fallback path")`.

**`resolveTargetRoot`:**
1. If `envValue` is a non-empty string → `resolve(envValue)`.
2. Else if `agentsRoot` is a non-empty string → `resolve(agentsRoot, "..")` (parent of agents/ — agents/ lives INSIDE the target repo).
3. Else throw `Error("Cannot resolve target repo root: set TARGET_REPO_PATH or pass a non-empty agentsRoot")`.

The "non-empty string" check (`typeof v === "string" && v.length > 0`) is identical for env values and fallback values — empty-string is treated as unset across the board. This is the v1 invariant the ticket calls out as load-bearing (a stray `AGENTS_REPO_PATH=` line in `.env` reads as `""`, not `undefined`).

### Resolution of the open architect call (agents-root fallback shape)

The ticket's open question: how should the agents-root fallback be derived now that v1's `__dirname + "../.."` offset no longer holds (v2 source ships from its own repo)?

**Decision: option (a) — drop the launcher-relative fallback. The dispatch-bin call site passes `fallback: undefined` and requires `AGENTS_REPO_PATH` to be set.**

Rationale:
- v1's offset existed only because the dispatcher source lived inside each consumer's `agents/dispatch/src/` tree. v2's source lives in `agent-dispatcher-v2/`, which has no fixed positional relationship to any consumer's `agents/`. There is no offset that resolves correctly.
- A marker walk-up (option b) adds code paths and edge cases for a convenience that hasn't been observed to matter — consumers invoke the dispatcher via a launcher script (`bin/pyry-start` in v1) that already sets `AGENTS_REPO_PATH` explicitly. Don't write a defense for an unobserved failure mode (CLAUDE.md "Don't").
- The launcher-relative offset (option c) would require hardcoding a v1-specific layout into v2's first module. That's anti-portability for forks.

**But the resolver still accepts `fallback`.** Two reasons:
- Tests need to exercise the fallback branch without setting an env var. With `fallback` as an input, tests pass `{ envValue: "", fallback: "/tmp/agents" }` and verify the second branch.
- A future caller (e.g., a launcher-bin that walks up looking for an `agents/` marker) can pass a derived fallback without changing the resolver. The signature stays open; the dispatch-bin call site closes it.

Document this choice in the function's leading comment so the next reader doesn't reinvent the marker-walk discussion.

### Data flow (downstream call site, out of scope here but informs the shape)

```
dispatch-bin.ts (or src/dispatch/...)
  ├─ reads process.env.AGENTS_REPO_PATH   ← I/O
  ├─ reads process.env.TARGET_REPO_PATH   ← I/O
  ├─ resolveAgentsRoot({ envValue, fallback: undefined })  ← pure
  ├─ resolveTargetRoot({ envValue, agentsRoot })           ← pure
  └─ passes both resolved paths into worktree/, github/, salvage/, ...
```

Each pure function is called once per process. Composition is one-way: target-root consumes the agents-root output but never the reverse.

## Concurrency model

N/A. Pure synchronous functions. No goroutines, no promises, no shared state.

## Error handling

- Both throw a vanilla `Error` with a message naming the env var the operator can set.
- Throwing (not returning a `Result`) matches v1 and matches the surrounding ecosystem (Node convention; vitest expects `expect(() => f()).toThrow()`).
- The error path is reached only on misconfiguration — runtime callers never recover from it. The dispatcher exits at the entry point.

## Testing strategy

Two test files under `test/paths/`. Use pure string inputs throughout — no tmpdir fixtures needed because `path.resolve` is platform-pure and doesn't touch the filesystem (the AC's "tmpdir fixture" allowance applies if a future test wants to verify a real directory; for this ticket, string inputs cover everything).

**`test/paths/agents-root.test.ts`** — at minimum:
- env override wins (env + fallback both non-empty → env's resolved path)
- empty-string env falls through to fallback
- undefined env falls through to fallback
- fallback path is resolved (`/foo/../bar` → `/bar`)
- env path is resolved (`/foo/../bar` → `/bar`)
- both empty/undefined throws; error message contains `AGENTS_REPO_PATH`
- (lock-in) the v1 bug protection: `resolveAgentsRoot({ envValue: undefined, fallback: "/work/pyrycode/agents" })` returns `/work/pyrycode/agents` exactly (not `/work/pyrycode` from a stray `..`)

**`test/paths/target-root.test.ts`** — at minimum:
- env override wins
- empty-string env falls through to `parent-of(agentsRoot)`
- undefined env falls through to `parent-of(agentsRoot)`
- works for any consumer (`/work/pyrycode/agents` → `/work/pyrycode`; `/work/pyrycode-mobile/agents` → `/work/pyrycode-mobile`; `/work/pyrycode-relay/agents` → `/work/pyrycode-relay`) — this locks in the "agents/ lives INSIDE the target, not as a sibling" invariant from the ticket
- both empty/undefined throws; error message contains `TARGET_REPO_PATH`
- (lock-in) does NOT reintroduce the `pyrycode/pyrycode/` bug — `resolveTargetRoot({ envValue: undefined, agentsRoot: "/work/pyrycode/agents" })` is `/work/pyrycode`, not `/work/pyrycode/pyrycode`

Each test file imports the module under test directly (`from "../../src/paths/agents-root.ts"`), not through the barrel. Vitest pattern matches `test/scaffold.test.ts`.

Test-first per CLAUDE.md: write the failing test, then the implementation. Don't backfill.

## Boundary rules (enforce, don't trust)

- Neither module imports from `src/index.ts`. Internal imports are direct relative paths only.
- Neither module reads `process.env`, calls `await`, shells out, or touches the filesystem. The only allowed import is `node:path`.
- TypeScript strict-mode compatible: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are on. Use `import type` for type-only imports per `verbatimModuleSyntax`.
- Run `pnpm typecheck && pnpm test && pnpm lint` before commit. Biome is wired up; honor its formatting.

## Open questions

None for this ticket. The fallback-shape question is resolved above; everything else is mechanical.

## Out of scope

- `resolveDefaultBranch` (v1's third path-resolution helper). Ships separately when `src/config/` lands — defaults belong with config loading, not path resolution.
- Reading `process.env` or capturing `__dirname` — those land at the call site once `src/dispatch/` arrives.
- Updating `src/index.ts` to re-export the new modules — the barrel populates module-by-module as `src/dispatch/` and `src/loop/` start consuming things; doing it now is premature and tempts future internal consumers to import through the barrel.
