# Spec — #89 `cleanupAfterDispatch`: release the transient `wip:<agent>` label

## Files to read first

- `src/dispatch/handleDispatchError.ts` (whole file, ~63 lines) — the closest stylistic sibling. Same shape: pre-fetched DI-only module, header comment naming the carve-out, `Pick<GitHubLabelsClient, ...>` dep type, `Promise<void>` return. Copy this layout verbatim except swap `addLabel` for `removeLabel` and drop the logger.
- `src/dispatch/handlePostRun.ts` (whole file, ~42 lines) — the leaner sibling. Confirms the minimal shape when there's no logger and no try/catch — `cleanupAfterDispatch` is closer to this in size than to `handleDispatchError`.
- `src/dispatch/state.ts` (whole file, ~20 lines) — `DispatchState` shape your function consumes. `state.agent` is the `Agent` union; `state.issueNumber` is the label target.
- `src/github/labels.ts:49-59` — the `removeLabel` contract. The header comment block already documents "GET-then-PUT-only-if-present" and the "skip-when-absent fast path"; cite this when you state the idempotency claim in your file header.
- `src/pipeline/transitions.ts:37-41` — the source-of-truth `wip:*` / `error:*` / metadata carve-out comment. Your file header must point to this line range verbatim — same convention `handleDispatchError.ts:7-12` and `handlePostRun.ts:11-22` already follow.
- `test/dispatch/handleDispatchError.test.ts` (whole file, ~119 lines) — copy the `fakeLabels` helper and `makeState` factory pattern. Strip the logger pieces and adapt `onAdd` → `onRemove`. Use the same `describe`/`it` style.
- `test/dispatch/handlePostRun.test.ts` (whole file, ~65 lines) — the leaner test-file precedent for a no-logger dispatch phase.
- `src/pipeline/selection.ts:24` — the `Agent` union (`"po" | "architect" | "developer" | "code-review" | "documentation"`). Determines the literal type of `wip:${state.agent}`. Note that `wip:*` is **not** in the `Label` union at `transitions.ts:42-51`, so a `satisfies Label` annotation is intentionally NOT used here — that's the carve-out.

## Context

Pre-dispatch (#77's surviving children landed `wip:<agent>` adds elsewhere; this phase is the release side). After the agent run completes — success OR failure — the dispatcher must clear `wip:<state.agent>` so the next loop iteration sees the ticket as not-running. Without this, every dispatched ticket gets stuck "in-flight" forever and `selectDispatches.cap` short-circuits at zero.

`wip:*` is dispatcher run-state, not a transition trigger (`transitions.ts:37-41`). It's deliberately absent from the `Label` union, so all four label-mutation funnels through `decideLabelDelta` would have nothing to say about it — this phase legitimately calls `removeLabel` directly. Same carve-out pattern as `handleDispatchError.ts` (adds `error:dispatch`) and `salvage/draft-pr.ts` (adds `error:max_turns_salvaged`).

This ticket is the cleanup-on-exit primitive. Wiring it into the orchestrator (`finally` block that runs after happy and error paths alike) is a follow-up; this ticket exports the function and unit-tests its behaviour against DI fakes only.

## Design

### File layout

One new production file, one new test file:

```
src/dispatch/cleanupAfterDispatch.ts        # ~30–35 lines incl. header comment
test/dispatch/cleanupAfterDispatch.test.ts  # ~50–60 lines
```

No other file changes. No barrel updates (`src/dispatch/` has none, per CLAUDE.md "Don't import from a barrel file"). The orchestrator wiring is out of scope.

### Production module shape

```ts
// src/dispatch/cleanupAfterDispatch.ts

// Per-dispatch cleanup. Removes the transient wip:<agent> label that
// pre-dispatch armed to prevent double-dispatch. Runs on the exit path
// of every dispatched ticket — happy OR error — so the next loop
// iteration sees a clean slate.
//
// Carve-out: wip:* is dispatcher run-state, not a transition trigger.
// Per the comment block at src/pipeline/transitions.ts:38-41 the Label
// union explicitly excludes wip:*, so this phase legitimately calls
// removeLabel directly via injected deps rather than funnelling through
// decideLabelDelta. Same precedent as handleDispatchError.ts (error:*)
// and salvage/draft-pr.ts (error:max_turns_salvaged).
//
// Idempotency: removeLabel at src/github/labels.ts:54 is GET-then-PUT-
// only-if-present — invoking against a ticket whose wip:<agent> label
// is already absent is a silent no-op (no throw, no PUT). This wrapper
// inherits that contract without adding an extra existence check; doing
// so here would duplicate the underlying I/O.

import type { GitHubLabelsClient } from "../github/labels.ts";
import type { DispatchState } from "./state.ts";

export interface CleanupAfterDispatchDeps {
  readonly labels: Pick<GitHubLabelsClient, "removeLabel">;
}

export async function cleanupAfterDispatch(
  state: DispatchState,
  deps: CleanupAfterDispatchDeps,
): Promise<void> {
  const wipLabel = `wip:${state.agent}`;
  await deps.labels.removeLabel(state.issueNumber, wipLabel);
}
```

Notes on the shape:

- **No `satisfies Label`.** `handlePostRun.ts` writes `` `ready:${state.agent}` satisfies Label `` because `ready:*` IS a member of the `Label` union — that line is a compile-time guarantee that adding a new `Agent` member without its `ready:*` becomes a type error. `wip:*` is **not** in `Label` (that's the carve-out), so a `satisfies Label` here would refuse to compile. The literal template string is fine on its own.
- **No try/catch.** Mirror `handlePostRun.ts`, not `handleDispatchError.ts`. `removeLabel` already has GET-then-PUT-only-if-present semantics, so the "label doesn't exist" case can't throw. Other transport errors (HTTP 5xx, network drop) should propagate to the caller, which decides how to log them. Swallowing here would hide cleanup failures from the orchestrator — see #88's symmetry note about catch-path vs. salvage's "rethrows on addLabel failure" contract; this is on the happy-and-error-exit path and should propagate.
- **Pick the narrowest interface.** `Pick<GitHubLabelsClient, "removeLabel">` keeps the surface area testable with a one-method fake and prevents accidental dependence on `addLabel` / `setLabels`.
- **No logger dep.** The orchestrator owns logging the cleanup outcome; this module just performs the I/O. Adding a logger here would duplicate the orchestrator's outer wrap.
- **No worktree teardown.** Explicitly out of scope per the issue body. The worktree primitive does not yet have a paired teardown surface; wiring it is a separate ticket.

### Test module shape

Mirror `test/dispatch/handlePostRun.test.ts` (the no-logger sibling):

```ts
// test/dispatch/cleanupAfterDispatch.test.ts

import { describe, expect, it } from "vitest";
import { cleanupAfterDispatch } from "../../src/dispatch/cleanupAfterDispatch.ts";
import type { DispatchState } from "../../src/dispatch/state.ts";
import type { Agent } from "../../src/pipeline/selection.ts";

function fakeLabels(behavior?: {
  onRemove?: (n: number, name: string) => void | Promise<void>;
}) {
  const calls: Array<{ number: number; name: string }> = [];
  const removeLabel = async (number: number, name: string): Promise<void> => {
    calls.push({ number, name });
    if (behavior?.onRemove) await behavior.onRemove(number, name);
  };
  return { calls, client: { removeLabel } };
}

function makeState(overrides?: Partial<DispatchState>): DispatchState {
  return {
    agent: "developer",
    issueNumber: 89,
    worktreePath: "/tmp/wt",
    args: [],
    ...overrides,
  };
}
```

Three required `it(...)` cases:

1. **Happy path — `wip:<agent>` is removed via the injected dep.**
   - `makeState({ agent: "architect", issueNumber: 87 })`, fresh `fakeLabels()`.
   - Assert `labels.calls` equals `[{ number: 87, name: "wip:architect" }]`.
   - Assert the function resolves `undefined`.
2. **Idempotent no-op when the label is absent.**
   - The fake's `removeLabel` simulates the "already absent" case by simply not throwing and returning normally — this matches how the real `GitHubLabelsClient.removeLabel` behaves when the GET shows the label isn't present (it returns without issuing a PUT, but from the wrapper's POV the call still resolves cleanly).
   - The behavior under test is "the wrapper does NOT add its own existence check before calling `removeLabel`". Assert: `cleanupAfterDispatch` issues exactly one `removeLabel` call (no pre-check GET, no conditional), and resolves `undefined`. This is what AC bullet 2 requires.
3. **Per-agent label naming covers every `Agent`.** (Mirrors `handlePostRun.test.ts`'s "per-agent label naming" case — load-bearing because there's no `satisfies Label` in production code to catch a regression at compile time.)
   - Loop over `["po", "architect", "developer", "code-review", "documentation"] as const`, call `cleanupAfterDispatch` with each, assert the recorded call name is `wip:${agent}` verbatim.

Optional fourth case (recommended, not required by AC): **transport error propagates.** Set `onRemove: () => { throw new Error("HTTP 500"); }` and `expect(...).rejects.toThrow("HTTP 500")` — locks in the "no swallow" contract symmetric to `handlePostRun.test.ts:55-64`.

## Concurrency model

None. Single `await deps.labels.removeLabel(...)`. No `AbortSignal`, no fan-out, no shared mutable state. The orchestrator owns ordering against `handlePostRun` / `handleDispatchError`.

## Error handling

- **Transport failure (HTTP 5xx, network drop) → throw.** Propagate to caller. The orchestrator's outer `finally`-and-log handles observability.
- **Label already absent → no-op.** Inherited from `removeLabel`'s GET-then-PUT-only-if-present. No wrapper code needed — that's the whole point of AC bullet 2.
- **`state.agent` invalid → can't happen at runtime.** `Agent` is a string literal union, narrowed at the type level upstream. The template string `` `wip:${state.agent}` `` is total over the union.

## Testing strategy

- Unit tests only, against DI fakes. No real GitHub I/O.
- Test file imports nothing from `src/github/` — the fake satisfies `Pick<GitHubLabelsClient, "removeLabel">` structurally.
- `pnpm typecheck && pnpm test` must pass green before commit (AC bullet 7).

## Open questions

None substantive. Two follow-ups worth filing as separate tickets when their consumers land:

1. **Wiring.** Which orchestrator surface (`runDispatchOnce`? a dedicated `finally` block in the per-ticket try/catch?) calls `cleanupAfterDispatch`. This ticket exports the primitive; the wiring ticket consumes it.
2. **Worktree teardown.** Out of scope here per the issue body. When the launcher decides worktrees should be reaped per-dispatch, a sibling `teardownWorktree` primitive lands and the orchestrator's `finally` calls both.

Neither blocks this ticket.

## Sizing confirmation

- Production code: ~12 lines of TypeScript + ~20 lines of header comment ≈ **30–35 lines total**, one new file.
- Test code: ~50–60 lines, one new file.
- New exported types: 1 (`CleanupAfterDispatchDeps`) plus one async function.
- New files: 2.
- Consumer call sites updated: **0** (wiring is a follow-up).
- Acceptance criteria: 7 bullets, all bounded inside the two new files.

No red line tripped. Sized **XS** as PO labelled.
