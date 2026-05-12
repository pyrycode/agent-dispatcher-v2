# Spec — #68: Inject `PYRY_PARENT_ITEM_ID` env var into the spawn descriptor

## Files to read first

- `src/dispatch/state.ts:1-20` — current `DispatchState` shape. This ticket adds ONE optional field (`parentProjectItemId`); the existing `agent` / `issueNumber` / `worktreePath` / `args` fields stay untouched. The field is optional so the four existing `makeState` overrides in the test suite (handleDispatchError, handlePostRun, cleanupAfterDispatch, setupBranchAndWorktree) keep compiling without edits.
- `src/dispatch/prepareAgentSpawn.ts:35-44` — the function body this ticket modifies. Today it returns `{ args, env: scrubEnv(parentEnv), cwd }`. The new body must add `PYRY_PARENT_ITEM_ID` to the returned env iff `state.parentProjectItemId !== undefined`, AFTER scrubbing — see "Design" for the exact merge order and rationale.
- `src/claude/spawn.ts:30-58` — `SPAWN_ENV_DENYLIST` and `scrubSpawnEnv`. `PYRY_PARENT_ITEM_ID` is NOT added to this set (AC bullet 3). The existing exact-contents pin in `test/claude/spawn.test.ts:30-34` provides the deterministic backstop against future denylist drift.
- `test/dispatch/prepareAgentSpawn.test.ts:21-29` — the `makeState` helper this test file already uses. The new tests extend it with the `parentProjectItemId` override; existing callers stay unchanged because the field is optional.
- `test/dispatch/prepareAgentSpawn.test.ts:31-108` — existing test idiom (record `scrubEnv` calls into `calls`, assert against `result.env`, use `in` operator for absence checks not `===`). Mirror this exactly for the three new tests.
- `test/claude/spawn.test.ts:20-34` — the `EXPECTED_DENYLIST` array + exact-contents pin. The new test in this file is the explicit positive assertion `SPAWN_ENV_DENYLIST.has("PYRY_PARENT_ITEM_ID") === false`, which pins by name and survives any reordering of `EXPECTED_DENYLIST` (the existing pin already fails if anyone *adds* a key, but a by-name pin is documentary and survives future denylist *additions* of unrelated keys).
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — confirms `prepareAgentSpawn` stays in `src/dispatch/` and its body imports nothing from `src/claude/` (scrubber comes via deps).
- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — both modified files stay tiny; `prepareAgentSpawn.ts` lands at ~32 lines, `state.ts` at ~24.
- Issue #68 body (in this conversation) — § "Out of Scope" pins what this ticket explicitly does NOT do (no dispatch-entry wiring, no PO CLAUDE.md change).

## Context

When PO splits a ticket, the new child issues currently land at the top of Backlog because PO has no handle on the parent's project-item ID to pass as `afterId` to `updateProjectV2ItemPosition`. A v1 stopgap (PO runs its own GraphQL `projectItems` lookup) shipped 2026-05-11 and covers the gap until v2 cutover; this ticket lands the v2 contract that lets the stopgap go away.

The dispatcher already has the parent's project-item ID in memory when it selects a ticket (the v2 dispatch entry that constructs `DispatchState` is the work of #78 and successors). Once that wiring lands, surfacing the ID to PO is a one-env-var hop. This ticket lands the contract: `DispatchState.parentProjectItemId` flows through `prepareAgentSpawn` to emerge as `PYRY_PARENT_ITEM_ID` in the spawn descriptor's env, and is not stripped by `scrubSpawnEnv`.

The contract is agent-agnostic. The descriptor emits whatever `state.parentProjectItemId` holds; nothing here keys on `state.agent === "po"`. The dispatch caller decides when to populate the field.

## Design

### New / modified files

```
src/dispatch/
  state.ts               (MODIFIED — +1 optional field, ~24 lines total)
  prepareAgentSpawn.ts   (MODIFIED — env-merge step + comment, ~32 lines total)
test/dispatch/
  prepareAgentSpawn.test.ts (MODIFIED — +3 tests for the new behaviour)
test/claude/
  spawn.test.ts          (MODIFIED — +1 test pinning PYRY_PARENT_ITEM_ID is not denylisted)
docs/specs/architecture/
  68-pyry-parent-item-id-env-var.md  (NEW — this file)
```

No other file is touched. No new module, no new exported type. `AgentSpawnDescriptor` / `PrepareAgentSpawnDeps` are unchanged.

### `DispatchState` change (`src/dispatch/state.ts`)

Append ONE optional field. The field is optional (`?:`) because:

1. The dispatch-entry wiring that populates it belongs to #78 and successors. Until then, the field stays unset and the descriptor's env-merge branch is the inert path.
2. Non-project-board dispatch paths (if any future caller bypasses the board) have nothing to pass.
3. Making it optional means the four existing test-suite `makeState` helpers do not need to learn about this field.

```typescript
export interface DispatchState {
  readonly agent: Agent;
  readonly issueNumber: number;
  readonly worktreePath: string;
  readonly args: readonly string[];
  // GraphQL ID of the dispatched ticket's project-board item. When set,
  // prepareAgentSpawn surfaces it to the spawned agent as
  // PYRY_PARENT_ITEM_ID so PO can position split-child issues relative to
  // the parent's column slot (issue #68). Optional because not every
  // dispatch path has the ID at hand — wiring at the dispatch entry point
  // is #78's job.
  readonly parentProjectItemId?: string;
}
```

The comment names the consumer (PO) and the wiring ticket (#78) so future readers don't grep blindly.

### `prepareAgentSpawn` change (`src/dispatch/prepareAgentSpawn.ts`)

The env-merge happens AFTER `scrubEnv` runs on `parentEnv`. Rationale:

- `state.parentProjectItemId` is dispatcher-internal state (constructed by the dispatch caller from the project-board response), not inherited from the dispatcher process env. It must land in the child regardless of whether `parentEnv` happens to contain a `PYRY_PARENT_ITEM_ID` entry. Merging post-scrub guarantees this — and trivially handles the (unlikely) case where the dispatcher process itself was spawned with `PYRY_PARENT_ITEM_ID` set: the inner ticket's state value wins.
- Doing it post-scrub also keeps `scrubEnv` pure on the immutable `parentEnv` snapshot (we don't mutate inputs).

The body becomes:

```typescript
export function prepareAgentSpawn(
  state: DispatchState,
  deps: PrepareAgentSpawnDeps,
): AgentSpawnDescriptor {
  const scrubbed = deps.scrubEnv(deps.parentEnv);
  const env: NodeJS.ProcessEnv =
    state.parentProjectItemId === undefined
      ? scrubbed
      : { ...scrubbed, PYRY_PARENT_ITEM_ID: state.parentProjectItemId };
  return {
    args: state.args,
    env,
    cwd: state.worktreePath,
  };
}
```

Two branches, not three:
- **Unset (`undefined`)**: return the scrubbed object verbatim. Reference identity with `scrubbed` is preserved — no clone, no extra allocation.
- **Set**: shallow-spread `scrubbed` and add the key. The spread is intentional so we do not mutate `scrubbed` (which the deps' `scrubEnv` may have constructed as a fresh object but production code shouldn't rely on that).

The conditional uses `=== undefined` (not `!= null`, not truthy) so empty-string values would land verbatim. Per AC bullet 2, the *unset* path omits the variable entirely — `undefined` is the only sentinel that triggers omission. An empty-string `parentProjectItemId` is not a contract we expect callers to use, but it's not our place to invent a "really unset" predicate here.

The file header comment gets one new sentence noting the env-merge step:

> `state.parentProjectItemId`, when set, is appended to the descriptor's env as `PYRY_PARENT_ITEM_ID` AFTER `scrubEnv` runs — see #68 spec for the merge-order rationale.

### `SPAWN_ENV_DENYLIST` (`src/claude/spawn.ts`)

**Unchanged.** AC bullet 3 explicitly requires the variable to survive `scrubSpawnEnv`. The denylist's existing seven keys are correct as-is.

The exact-contents pin in `test/claude/spawn.test.ts:30-34` already deterministically backstops "no one accidentally adds `PYRY_PARENT_ITEM_ID` to the denylist" — adding it would break that test. The new positive test (below) is documentary belt-and-suspenders: it names the key explicitly so the *intent* (this variable must reach the agent) survives even if someone refactors the exact-contents pin away in the future.

### Test additions

**`test/dispatch/prepareAgentSpawn.test.ts`** — three new tests, mirrors the existing idiom.

1. *Descriptor includes `PYRY_PARENT_ITEM_ID` with the expected value when set.*
   ```
   state = makeState({ parentProjectItemId: "PVTI_lADO_sentinel" })
   result = prepareAgentSpawn(state, deps)
   expect(result.env.PYRY_PARENT_ITEM_ID).toBe("PVTI_lADO_sentinel")
   ```
   Also assert PATH is preserved (covers "did not nuke the scrubbed env").

2. *Descriptor omits `PYRY_PARENT_ITEM_ID` entirely (not empty string) when the field is unset.*
   ```
   state = makeState()  // parentProjectItemId undefined
   result = prepareAgentSpawn(state, deps)
   expect("PYRY_PARENT_ITEM_ID" in result.env).toBe(false)
   ```
   Use the `in` operator, not equality with undefined — pins the contract per AC bullet 2 ("omits the variable entirely (not empty string) when unset").

3. *The post-scrub merge does not re-introduce denylisted keys.*
   ```
   state = makeState({ parentProjectItemId: "PVTI_x" })
   parentEnv = { GITHUB_TOKEN: "secret", PATH: "/usr/bin" }
   result = prepareAgentSpawn(state, deps)
   expect("GITHUB_TOKEN" in result.env).toBe(false)
   expect(result.env.PYRY_PARENT_ITEM_ID).toBe("PVTI_x")
   ```
   Confirms the merge order didn't accidentally re-shape the scrubber's output. Catches a future refactor that pre-scrubs into `scrubbed` then spreads `parentEnv` on top.

Update `makeState` (line 21-29) to thread the new optional override through `...overrides` — already does, since it uses `Partial<DispatchState>`. No edit needed to the helper itself; the new tests just pass `{ parentProjectItemId: "..." }` in the override bag.

**`test/claude/spawn.test.ts`** — one new test inside the existing `SPAWN_ENV_DENYLIST` describe block.

4. *`PYRY_PARENT_ITEM_ID` is not in the denylist (by-name pin).*
   ```
   it("does not include PYRY_PARENT_ITEM_ID (must survive scrubbing — #68)", () => {
     expect(SPAWN_ENV_DENYLIST.has("PYRY_PARENT_ITEM_ID")).toBe(false);
   });
   ```
   Documentary: the comment cites #68 so a future contributor adding the key to the denylist is forced to discover the consumer-side dependency.

AC bullet 4 sub-bullet (c) ("the var survives `scrubSpawnEnv`") is satisfied compositely by tests (1) and (4): (1) shows the var reaches the descriptor, (4) shows scrubbing can't strip it. An additional direct test of `scrubSpawnEnv({ PYRY_PARENT_ITEM_ID: "x" })` is redundant — the `scrubSpawnEnv` body is a single-pass denylist filter and (4) pins the only relevant invariant. Skip it to keep the test count tight.

### Required edits to existing files

The four other `makeState` helpers (`test/dispatch/{handleDispatchError,handlePostRun,cleanupAfterDispatch,setupBranchAndWorktree}.test.ts`) DO NOT need edits — they use `Partial<DispatchState>` and the new field is optional. Verified: every existing test constructs a state that satisfies the *required* fields; an optional addition is non-breaking.

## Concurrency model

N/A — this is a pure function. No async, no I/O.

## Error handling

No new error paths. `state.parentProjectItemId` is either a string or `undefined`; both branches are total. The scrubber's contract (returns a fresh env dict, never throws) is unchanged.

## Testing strategy

Unit tests only — same as the existing `prepareAgentSpawn.test.ts` and `spawn.test.ts` suites. No integration test, no fixture, no subprocess. The four new tests above (three in `prepareAgentSpawn.test.ts`, one in `spawn.test.ts`) exhaustively cover the AC.

Run locally:

```
pnpm typecheck && pnpm test
```

Expected: all existing tests continue to pass; four new tests added.

## Open questions

None. The env-merge shape is decided (post-scrub spread); the denylist is unchanged; the consumer (#78) and stopgap (v1 forks, 2026-05-11) are documented for future readers.

## Out of scope (mirrors issue body for the developer's convenience)

- **Do not** edit any agents-repo file. PO's `CLAUDE.md` change lives in `agent-dispatcher-v2-agents`, not here.
- **Do not** wire `parentProjectItemId` into any caller of `DispatchState` constructors. That is #78's contract. Until #78 lands, the new field stays unset and the new env-merge branch is exercised only by the unit tests.
- **Do not** rename, extract, or "while-I'm-here" refactor `prepareAgentSpawn`. The body diff is ~5 lines; ship it.
