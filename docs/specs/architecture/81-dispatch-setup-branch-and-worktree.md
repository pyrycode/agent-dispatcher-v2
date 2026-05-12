# Spec — #81: `setupBranchAndWorktree` + `DispatchState`

## Files to read first

- `src/pipeline/branch-setup.ts:32-37` — `decideBranchSetup` predicate. The orchestrator's create-vs-reuse rule delegates here; the result's `kind` and `branch` map straight onto the result type below. The `labels` field on `BranchSetupState` is unread (see comment at lines 11-14) — pass `[]` from this orchestrator since `DispatchState` carries no labels yet.
- `src/pipeline/branch-setup.ts:9-24` — `BranchSetupState` / `BranchSetupDecision` shapes consumed by the predicate.
- `src/pipeline/selection.ts:24` — canonical `Agent` union (`"po" | "architect" | "developer" | "code-review" | "documentation"`). `DispatchState.agent` reuses this type, *imported* (not re-declared).
- `src/worktree/create.ts:27-58` — `createWorktree(branch, repoRoot, worktreeDir, spawn)` is the materialization primitive. This ticket does NOT call it directly; the launcher pre-binds it into the dep. Read the signature so the dep contract below mirrors it on the relevant edge (branch in, resolved path out).
- `src/salvage/draft-pr.ts:14-43` — reference pattern for "small DI'd unit consuming pre-bound I/O deps." Mirror the shape of `SalvageDraftPrDeps` / `openSalvageDraftPr(deps, input)` exactly: deps interface declared in this module, function takes `(state, deps)`, body is straight-line. No class, no factory.
- `test/salvage/draft-pr.test.ts:9-47` — reference pattern for the fake-deps test style (record calls into a `calls` array, return a stub from the fake closure, assert on shape). Mirror this in the new test file.
- `src/github/pr.ts:1-26` — confirms no existing-PR-by-issue lookup is exposed today (`createPr` / `enableAutoMerge` / `mergePr` only). The dep shape this ticket defines is a NEW seam; production wiring is out of scope (see "Out of scope" below).
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — the rule that justifies why this file lives under `src/dispatch/` and not `src/pipeline/` despite delegating to a pure predicate.
- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — both new files target ~30-80 lines; don't merge them.

## Context

v1 ships a single ~500-line `dispatch.ts` that interleaves every per-ticket phase. v2 splits each phase into a small DI'd function so unit tests pass fakes and the orchestrator (later ticket) composes them. This ticket lands the first pre-spawn phase and the shared `DispatchState` type that downstream phase tickets (#82's `prepareAgentSpawn`, post-spawn phases to follow) extend.

The function `setupBranchAndWorktree` is an I/O *orchestrator*, not a pure predicate. It runs at the I/O edge (calls a GitHub lookup, calls a worktree-creation primitive), so it lives under `src/dispatch/` per CLAUDE.md. The decision logic itself stays delegated to the pure `decideBranchSetup` in `src/pipeline/branch-setup.ts` — this orchestrator never re-derives the create-vs-reuse rule inline.

## Design

### New files

```
src/dispatch/
  state.ts                       (~15-25 lines)
  setupBranchAndWorktree.ts      (~40-60 lines)
test/dispatch/
  setupBranchAndWorktree.test.ts (~80-120 lines)
```

No other file is touched. No barrel, no index — internal imports are direct per CLAUDE.md § "Don't import from a barrel file."

### `src/dispatch/state.ts`

```ts
// Shared dispatch-state contract. Each per-ticket phase under src/dispatch/
// reads and (when needed) extends this type. Kept deliberately minimal — fields
// are added only when a phase actually reads them, not pre-emptively. Reuses
// the canonical Agent union from src/pipeline/selection.ts rather than
// redeclaring it (no second narrow type for the same concern).

import type { Agent } from "../pipeline/selection.ts";

export interface DispatchState {
  readonly agent: Agent;
  readonly issueNumber: number;
}
```

Rationale for "no `labels`": `decideBranchSetup` doesn't read `labels` (see comment at `branch-setup.ts:11-14`). Adding it here pre-emptively would violate the ticket's "Keep it minimal" directive. When a later phase needs labels in `DispatchState`, that phase's ticket adds the field.

### `src/dispatch/setupBranchAndWorktree.ts`

```ts
// Pre-spawn phase 1: pick the feature branch (fresh feature/<n> vs reuse of
// an existing PR's head ref) and materialize the worktree. Pure-predicate
// decision delegated to decideBranchSetup; I/O taken from injected deps so
// unit tests DI fakes. No `gh` or `git` invocation lives in this file.
//
// The dep `lookupExistingPrHeadRef` is a NEW seam — src/github/pr.ts does
// not yet expose a by-issue PR-head-ref lookup. Wiring the production
// implementation is a follow-up ticket; this module defines only the shape.
//
// The dep `createWorktree` is the launcher-bound surface of the primitive at
// src/worktree/create.ts:27. The launcher binds (repoRoot, worktreeDir, spawn)
// once; this orchestrator only passes the branch and consumes the returned
// path. The branch-in/path-out shape mirrors the primitive's load-bearing edge.

import { decideBranchSetup } from "../pipeline/branch-setup.ts";
import type { DispatchState } from "./state.ts";

export interface SetupBranchAndWorktreeDeps {
  readonly lookupExistingPrHeadRef: (issueNumber: number) => Promise<string | null>;
  readonly createWorktree: (branch: string) => Promise<string>;
}

export interface SetupBranchAndWorktreeResult {
  readonly branch: string;
  readonly worktreePath: string;
  readonly kind: "create" | "reuse";
}

export async function setupBranchAndWorktree(
  state: DispatchState,
  deps: SetupBranchAndWorktreeDeps,
): Promise<SetupBranchAndWorktreeResult> {
  const existingPrHeadRef = await deps.lookupExistingPrHeadRef(state.issueNumber);
  const decision = decideBranchSetup({
    issueNumber: state.issueNumber,
    // `decideBranchSetup` does not read `labels` — see comment at
    // src/pipeline/branch-setup.ts:11-14. Passed empty to satisfy the
    // predicate's type without inflating DispatchState.
    labels: [],
    existingPrHeadRef,
  });
  const worktreePath = await deps.createWorktree(decision.branch);
  return { branch: decision.branch, worktreePath, kind: decision.kind };
}
```

### Imports allowed / forbidden

This module's import block is the AC bullet 3 contract:

- **Allowed**: `../pipeline/branch-setup.ts` (pure predicate), `./state.ts` (sibling type)
- **Forbidden**: anything under `src/github/`, anything under `src/worktree/`

The forbidden imports are how production I/O *would* leak in. With the dep shapes above, the launcher does the binding; this file body knows nothing about GitHub or git.

## Data flow

```
caller (future orchestrator)
  │
  │ DispatchState { agent, issueNumber }
  ▼
setupBranchAndWorktree(state, deps)
  │
  │ deps.lookupExistingPrHeadRef(issueNumber)
  ▼
  string | null
  │
  │ decideBranchSetup({ issueNumber, labels: [], existingPrHeadRef })
  ▼
  { kind, branch }
  │
  │ deps.createWorktree(branch)
  ▼
  worktreePath: string
  │
  ▼
SetupBranchAndWorktreeResult { branch, worktreePath, kind }
```

No internal concurrency: the two I/O calls are strictly sequential (the second's branch comes from the first's lookup feeding the predicate). No `Promise.all`, no `AbortSignal` plumbing in this phase — the orchestrator that composes phases handles cancellation across the whole sequence.

## Error handling

Errors propagate verbatim (same posture as `src/worktree/create.ts` and `src/salvage/draft-pr.ts`):

- `lookupExistingPrHeadRef` throws → orchestrator never calls `createWorktree`; the throw surfaces to the caller. No `try`/`catch` in this module.
- `createWorktree` throws (path collision, branch checked out elsewhere, generic git failure) → re-thrown verbatim. Collision recovery is the *caller's* concern per the invariant pinned in `src/worktree/create.ts:8-13` — this orchestrator stays silent on recovery.

No partial results. If `lookupExistingPrHeadRef` returns and `createWorktree` then throws, the caller sees the throw with no return value; no half-state leaks back.

## Testing strategy

Test file: `test/dispatch/setupBranchAndWorktree.test.ts`. Mirror the fake-deps idiom from `test/salvage/draft-pr.test.ts:9-47`:

```ts
function fakeDeps(opts: {
  existingPrHeadRef: string | null;
  worktreePath?: string;
  onLookup?: (issueNumber: number) => void;
  onCreate?: (branch: string) => void;
}) {
  const calls = { lookup: [] as number[], create: [] as string[] };
  return {
    calls,
    deps: {
      lookupExistingPrHeadRef: async (n: number) => {
        calls.lookup.push(n);
        opts.onLookup?.(n);
        return opts.existingPrHeadRef;
      },
      createWorktree: async (branch: string) => {
        calls.create.push(branch);
        opts.onCreate?.(branch);
        return opts.worktreePath ?? `/tmp/${branch.replace("/", "-")}`;
      },
    },
  };
}
```

Required cases (AC bullet 5 — both paths):

1. **`reuse` path** — `lookup` returns `"feature/42"`. Assert: result is `{ branch: "feature/42", worktreePath, kind: "reuse" }`; `calls.lookup === [42]`; `calls.create === ["feature/42"]`.
2. **`create` path** — `lookup` returns `null`. Assert: result is `{ branch: "feature/42", worktreePath, kind: "create" }`; `calls.lookup === [42]`; `calls.create === ["feature/42"]` (the predicate-derived fresh branch name).

Additional case to lock down sequencing / failure propagation (lifted from the salvage test pattern, cheap to add):

3. **Ordering** — pushes `"lookup"` then `"create"` into a shared events array via the `onLookup` / `onCreate` callbacks; assert `events === ["lookup", "create"]`. Pins that no parallel execution sneaks in via a future refactor.
4. **`lookup` throws → `create` never invoked** — assert the rejection rethrows verbatim; `calls.create.length === 0`. Pins the AC bullet 3 contract that the orchestrator doesn't swallow.
5. **`create` throws after `lookup` succeeded** — assert rejection rethrows verbatim; `calls.lookup.length === 1`. Pins the same posture on the second call.

The test file must NOT import from `src/github/` or `src/worktree/`. Imports are limited to `../../src/dispatch/state.ts`, `../../src/dispatch/setupBranchAndWorktree.ts`, and `vitest`. The lack of those imports is itself the structural enforcement of AC bullet 3 — if a future refactor leaks `gh`/git into the module body, the test would have to grow such an import to stub it, and the absence is the canary.

Use the `Agent` literal `"developer"` (or any of the canonical union members) when constructing test `DispatchState` values — do NOT redeclare the union locally.

## Acceptance criteria mapping

| AC bullet | Where pinned |
| --- | --- |
| Shared dispatch-state type exporting `{ agent, issueNumber }` from `src/dispatch/` | `src/dispatch/state.ts` |
| `setupBranchAndWorktree(state, deps)` exported from `src/dispatch/` returning `{ branch, worktreePath, kind }` | `src/dispatch/setupBranchAndWorktree.ts` |
| Function body imports nothing from `src/github/` or `src/worktree/` | Module import block — only `../pipeline/branch-setup.ts` and `./state.ts` allowed |
| Delegates create-vs-reuse to `decideBranchSetup` | Body calls `decideBranchSetup({ issueNumber, labels: [], existingPrHeadRef })` |
| Unit tests cover both `reuse` and `create` paths via fake deps | `test/dispatch/setupBranchAndWorktree.test.ts` cases 1-2 (plus 3-5 for sequencing / failure propagation) |

## Out of scope

- Production wiring of `lookupExistingPrHeadRef` against `src/github/pr.ts`. This ticket defines the dep *shape* only; the production implementation (which will likely add a `findPrByIssueNumber` method to `GitHubPrClient` or a sibling helper) is a follow-up ticket.
- Calling `setupBranchAndWorktree` from any real orchestrator. The orchestrator is later in the pre-spawn phase sequence — this ticket only lands the unit.
- Adding `labels`, `worktreeDir`, `repoRoot`, etc. to `DispatchState`. Fields are added by the phase ticket that first reads them.
- Touching `src/dispatch-bin.ts`, `src/loop/`, or anywhere else.

## Open questions

None. The dep shapes, file locations, and AC mapping are all explicit in the ticket body. The architectural choices made above (pre-binding `createWorktree`, leaving `labels` off `DispatchState`, no `Agent` redeclaration) follow directly from existing patterns in the repo.
