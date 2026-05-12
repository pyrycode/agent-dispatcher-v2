# Spec — `src/loop/cycle.ts` (`runCycle`)

Ticket: #53 — Land `src/loop/cycle.ts` — `runCycle` main poll loop with drain mode. Split from #13. Sibling #52 already landed the pure `decideAutoAdvance`; this ticket is now `cycle.ts` only.

## Files to read first

- `src/pipeline/selection.ts` (full, 90 lines) — `selectDispatches` signature, `SelectionItem` / `DispatchTuple` / `SelectionState` shapes, the `wip:*` eligibility predicate. Import `selectDispatches`, `SelectionItem`, `DispatchTuple`, `SelectionState` — **do not redeclare**.
- `src/pipeline/auto-advance.ts` (full, 56 lines) — `decideAutoAdvance(state, inFlightCount, maxConcurrent)` signature, the `capacity = max(0, maxConcurrent - inFlightCount)` formula, the `AdvanceDecision` shape. Import `decideAutoAdvance`, `AutoAdvanceState`, `AdvanceDecision`.
- `src/pipeline/transitions.ts:14-21` — `Column` type. Used in `AdvanceDecision.to`; imported transitively via `auto-advance.ts`.
- `src/loop/runDoneCleanup.ts` (full, 53 lines) — sibling runner shape for the maintenance pass. Note: narrow per-runner deps interfaces, async functions, no I/O imports of its own.
- `src/loop/runClosedSweep.ts` (full, 34 lines) — sibling runner.
- `src/loop/runAutoMerge.ts` (full, 49 lines) — sibling runner, has the conflict-rollback gate.
- `src/loop/runReworkRouting.ts` (full, 59 lines) — sibling runner. **`cycle.ts` does not duplicate these — it composes them via deps thunks** (see § Design § "Reconcile via thunks, not direct calls").
- `test/loop/runReworkRouting.test.ts` (full, 124 lines) — the test-file shape to mirror: recording fakes, `describe` grouping by concern, inline fixtures.
- `src/config/env.ts:20-32` — `Config` shape; the `pyryMaxConcurrent` field is the canonical source the launcher threads into `runCycle`. `runCycle` does not import `Config` directly — it takes a narrow `RunCycleConfig`.
- `docs/specs/architecture/52-pipeline-auto-advance.md` § "Capacity math" — the `Math.max(0, maxConcurrent - inFlightCount)` pattern this caller mirrors.
- `CLAUDE.md` § "The throughput equation is `min(...)` of every gate" — quote the equation verbatim in the file's top comment; this is the file where every term of that equation is observable end-to-end.
- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — target ~85 lines. If the body grows past 120, the maintenance pass is being inlined where it should be a thunk.
- `CLAUDE.md` § "Test-first" — RED → GREEN. Write the test file first, watch it fail, then implement.

## Context

`runCycle` is v2's heartbeat. Each tick it stitches together every pure-pipeline decision and every I/O surface that has landed so far:

1. **Fetch state** — one snapshot of the project board (items + their in-flight count).
2. **Select dispatches** — call `selectDispatches` with the remaining capacity.
3. **Run dispatches in parallel** — `Promise.allSettled` so one rejection does not abort siblings or the rest of the tick.
4. **Auto-advance** — call `decideAutoAdvance` and apply each `AdvanceDecision`.
5. **Maintenance pass** — call the four runners (`runDoneCleanup`, `runClosedSweep`, `runAutoMerge`, `runReworkRouting`) sequentially via deps thunks.

Then sleep until the next tick or, if the drain flag is raised, exit.

This is the file where the throughput equation

```
actual_wip = min(
  selectDispatches.cap,
  decideAutoAdvance.backlog_cap,
  blocker_chain,
  MANUAL_ADVANCE_GATES,
)
```

is observable end-to-end — both participating gates are called here, with the same effective capacity threaded through both. The system-level binding-cap test (AC 4) belongs here and only here.

**No `reconcile.ts` exists.** Parent ticket #13's mention of "`reconcile` (#14)" predates the split: ticket #14 landed as four sibling runners under `src/loop/run*.ts`. `runCycle` composes those directly via deps thunks; it does **not** introduce a `reconcile()` wrapper. (A wrapper would be a fifth label-mutation site — CLAUDE.md "`decideLabelDelta` is the only place labels mutate" forbids new ones; the four routines already cover the universe.)

## Design

### New file: `src/loop/cycle.ts`

```ts
// Main poll loop. Each tick:
//   1. Fetch snapshot (items + in-flight count).
//   2. selectDispatches over remaining capacity.
//   3. Promise.allSettled the selected dispatches.
//   4. decideAutoAdvance + apply each promotion.
//   5. Run the four maintenance routines via deps thunks.
// Drain is an AbortSignal; the launcher wires SIGTERM → controller.abort().
// On drain, the current tick's in-flight dispatches finish; no new tick starts.
//
// This is the file where the throughput equation
//   actual_wip = min(
//     selectDispatches.cap,
//     decideAutoAdvance.backlog_cap,
//     blocker_chain,
//     MANUAL_ADVANCE_GATES,
//   )
// is observable end-to-end. Both gates receive the same effective capacity:
//   capacity = max(0, maxConcurrent - inFlightCount)
// passed to selectDispatches AND consumed inside decideAutoAdvance. v1's
// 2026-05-08 bug (decideAutoAdvance hardcoded WIP=1, selectDispatches
// parameterised) is structurally impossible in v2 because both arms read
// from the same maxConcurrent.
//
// All external I/O reaches this function through `deps`, never via direct
// imports. The four maintenance runners are pre-bound thunks (the launcher
// constructs deps.runDoneCleanup = () => runDoneCleanup(doneCleanupDeps)) so
// runCycle carries no plumbing knowledge of listItems / removeLabel /
// setItemStatus / etc.

import {
  decideAutoAdvance,
  type AdvanceDecision,
} from "../pipeline/auto-advance.ts";
import {
  selectDispatches,
  type DispatchTuple,
  type SelectionItem,
} from "../pipeline/selection.ts";

export interface CycleSnapshot {
  // Board items in board-position order — the same shape both
  // selectDispatches and decideAutoAdvance consume. One fetch, one array.
  readonly items: readonly SelectionItem[];
  // Count of items currently carrying a wip:* label. The I/O layer derives
  // this from the same fetch (cheaper than a second query); runCycle does
  // not reimplement the wip:* predicate.
  readonly inFlightCount: number;
}

export interface RunCycleDeps {
  readonly fetchSnapshot: () => Promise<CycleSnapshot>;
  // Per-tuple dispatcher. Started in parallel; failures isolated by
  // Promise.allSettled (a rejection MUST NOT abort the tick or siblings).
  readonly dispatchAgent: (tuple: DispatchTuple) => Promise<void>;
  // Apply one AdvanceDecision via the GitHub project API. The thunk hides
  // the issueNumber → project-item-id resolution; runCycle does not see it.
  readonly applyAdvance: (decision: AdvanceDecision) => Promise<void>;
  // Maintenance pass — four pre-bound runners, called sequentially.
  readonly runDoneCleanup: () => Promise<void>;
  readonly runClosedSweep: () => Promise<void>;
  readonly runAutoMerge: () => Promise<void>;
  readonly runReworkRouting: () => Promise<void>;
  // Idle delay between ticks. DI'd so tests use () => Promise.resolve().
  readonly sleep: (ms: number) => Promise<void>;
}

export interface RunCycleConfig {
  readonly maxConcurrent: number;
  readonly pollIntervalMs: number;
  // Launcher wires process.on("SIGTERM", () => controller.abort()).
  readonly drain: AbortSignal;
}

export async function runCycle(
  deps: RunCycleDeps,
  config: RunCycleConfig,
): Promise<void> {
  while (!config.drain.aborted) {
    await tick(deps, config);
    if (config.drain.aborted) break;
    await deps.sleep(config.pollIntervalMs);
  }
}

async function tick(deps: RunCycleDeps, config: RunCycleConfig): Promise<void> {
  const snapshot = await deps.fetchSnapshot();
  const capacity = Math.max(0, config.maxConcurrent - snapshot.inFlightCount);

  const tuples = selectDispatches({ items: snapshot.items }, capacity);
  // Promise.allSettled — one rejection does NOT abort the tick. The tick
  // continues into auto-advance + reconcile regardless of any per-dispatch
  // outcome. Per-dispatch error logging is the dispatchAgent thunk's job.
  await Promise.allSettled(tuples.map((t) => deps.dispatchAgent(t)));

  const advances = decideAutoAdvance(
    { items: snapshot.items },
    snapshot.inFlightCount,
    config.maxConcurrent,
  );
  for (const advance of advances) {
    await deps.applyAdvance(advance);
  }

  await deps.runDoneCleanup();
  await deps.runClosedSweep();
  await deps.runAutoMerge();
  await deps.runReworkRouting();
}
```

### Effective-capacity threading (the throughput-equation invariant)

`selectDispatches(state, maxConcurrent)` caps the number of NEW dispatches at its `maxConcurrent` argument. It does **not** subtract already-in-flight items itself (its `wip:*` filter excludes them from the candidate list, but the cap is over new picks). To keep `actual_wip ≤ maxConcurrent`, the caller must pass `capacity = max(0, maxConcurrent - inFlightCount)` as `selectDispatches`'s second argument — not `config.maxConcurrent` directly. `decideAutoAdvance` already does this internally (`capacity = Math.max(0, maxConcurrent - inFlightCount)`); `runCycle` mirrors the math at the dispatch arm so both gates clamp to the same effective cap.

Two consequences:

| Scenario | `capacity` (for `selectDispatches`) | `decideAutoAdvance` internal capacity | Both gates? |
| --- | --- | --- | --- |
| `inFlightCount = 0, maxConcurrent = 2` | 2 | 2 | Up to 2 dispatches + up to 2 advances |
| `inFlightCount = 1, maxConcurrent = 2` | 1 | 1 | Up to 1 each |
| `inFlightCount = 2, maxConcurrent = 2` | 0 | 0 | **Both empty — binding cap (AC 4)** |
| `inFlightCount = 3, maxConcurrent = 2` (transient over-capacity) | 0 | 0 | Both empty, no throw |

Dispatch and auto-advance both consume the same capacity budget. They are not in tension: `selectDispatches` walks non-Backlog columns (architect/developer/code-review/documentation), `decideAutoAdvance` walks only Backlog. Both can fully use the capacity on the same tick — selected items dispatch this tick, advanced items dispatch next tick once their column is selectable. Allocation order does not matter for the throughput equation because `actual_wip` is bounded by `min(...)` of the gates, not by the sum of selections.

### Reconcile via thunks, not direct calls

`runCycle` does **not** import `runDoneCleanup` / `runClosedSweep` / `runAutoMerge` / `runReworkRouting`. Each is passed as a pre-bound thunk in `deps`. Rationale:

- The runners each take their own narrow deps (`DoneCleanupDeps`, `ClosedSweepDeps`, `AutoMergeDeps`, `ReworkRoutingDeps`). Importing them here would force `runCycle`'s deps to carry the union of all four — leaking `listItems` / `removeLabel` / `setItemStatus` / `listPrsForItem` / `mergePr` into a layer that has no concern with any of them.
- The launcher (`src/dispatch-bin.ts`, future ticket) constructs each runner's deps once at startup and binds them: `runDoneCleanup: () => runDoneCleanup(doneCleanupDeps)`. That's the right place for plumbing.
- Tests can stub each thunk independently: a recording `vi.fn()` per runner.

### Drain semantics (AC 3)

The drain flag is an `AbortSignal`. `runCycle` checks it at tick boundaries only:

- Before starting a tick: `while (!config.drain.aborted)`. If raised before the first tick, `runCycle` resolves immediately without doing any work.
- Between tick and sleep: a second `if (config.drain.aborted) break;` skips the sleep.
- **Mid-tick: no check.** Once `tick()` starts, it runs to completion. `Promise.allSettled` awaits every in-flight dispatch before the tick can resolve; `applyAdvance` calls and the four reconcile thunks run sequentially after that. This is the intended semantics — "stop accepting new work, finish in-flight dispatches, and exit cleanly". An in-flight dispatch is one that has already been started; we let it finish. New ticks (and therefore new dispatches) are what drain prevents.

`runCycle` does **not** register a SIGTERM handler. The launcher owns process signals; `runCycle` only knows about its `AbortSignal`. This keeps `runCycle` test-driveable without spawning real signals.

### Why `Promise.allSettled`, not `Promise.all`

`Promise.all` rejects on the first rejection and leaves the remaining promises unobserved — `runCycle` would propagate the rejection out of `tick`, the tick would skip auto-advance + reconcile, and the unhandled-rejection trap would log the still-pending siblings out of order. `Promise.allSettled` resolves only after every promise settles (fulfilled or rejected) and never throws. The tick continues into auto-advance + reconcile regardless of any per-dispatch outcome. AC 2 pins this: "three dispatches run in parallel, one rejects, and the other two settle without the tick throwing or aborting siblings."

`runCycle` ignores the returned settlement array — per-dispatch error handling (logging, error labels, salvage) lives inside `deps.dispatchAgent` and the future dispatch layer, not here. This file has one concern: tick orchestration.

### Polling, not event-driven

Tight loops would burn GitHub's GraphQL budget. `deps.sleep(config.pollIntervalMs)` between ticks gives operators a knob; tests inject `sleep: () => Promise.resolve()` so suite latency stays flat. The sleep is between ticks, not before the first tick — startup runs a tick immediately.

### Module-level data: none

No `const X =` derived from imports, no module-scope `let`. All state is parameters or `tick`-local. The `while` loop is the only mutation site, and its state is `config.drain.aborted` — read-only here.

## Test plan (RED first)

Create `test/loop/cycle.test.ts`, mirroring `test/loop/runReworkRouting.test.ts`'s shape: recording fakes for the narrow deps, `describe` per concern, inline `SelectionItem[]` fixtures.

The fixture factory shape:

```ts
function makeDeps(opts: {
  snapshot: CycleSnapshot;
  dispatchAgent?: (tuple: DispatchTuple) => Promise<void>;
}): {
  deps: RunCycleDeps;
  dispatched: DispatchTuple[];
  advanced: AdvanceDecision[];
  reconcileOrder: string[];
} { ... }
```

`reconcileOrder` records which of the four runners ran in which order (push `"doneCleanup"`, `"closedSweep"`, `"autoMerge"`, `"reworkRouting"` from each thunk).

Required cases (one per AC + the supporting cases the ACs imply):

| `describe` / `it` | Setup | Asserts |
| --- | --- | --- |
| **tick orchestration: happy path runs all five steps in order** | snapshot with 1 eligible non-Backlog item + 1 eligible Backlog item, `maxConcurrent=2`, `inFlightCount=0`, drain pre-aborted so the loop exits after one tick | `dispatched.length === 1`, `advanced.length === 1`, `reconcileOrder === ["doneCleanup", "closedSweep", "autoMerge", "reworkRouting"]` |
| **AC 2: Promise.allSettled isolates a rejecting dispatch** | snapshot with 3 eligible items in dispatchable columns, `maxConcurrent=3`, `inFlightCount=0`; `dispatchAgent` returns `Promise.reject(new Error("boom"))` for one tuple and resolved for the others; drain pre-aborted | `tick` does not throw; all 3 `dispatchAgent` calls were made; `applyAdvance` and the four reconcile thunks all ran |
| **AC 3: drain raised between ticks stops the loop** | snapshot returns one dispatchable item; `drain` is a controller raised inside the test after the first `fetchSnapshot` resolves but before `applyAdvance` (via a fake that aborts the controller on its first call); assert: first tick completes, second tick never starts | `fetchSnapshot.calls === 1`, `dispatchAgent.calls === 1`, `runCycle` resolves without throwing |
| **AC 3: drain raised mid-tick still completes in-flight dispatches** | snapshot returns 2 dispatchable items; `dispatchAgent` returns a `deferred` promise; test resolves both deferreds after raising `drain`; assert: both `dispatchAgent` calls were made and resolved before `runCycle` returns | `dispatched.length === 2`, both promises observed as fulfilled; `runCycle` resolves; `fetchSnapshot.calls === 1` (no second tick) |
| **AC 3: drain raised before first tick exits without work** | `drain.aborted` is `true` before `runCycle` is called | `fetchSnapshot.calls === 0`, no dispatches, no advances, no reconcile thunks |
| **AC 4: binding cap — `inFlightCount === maxConcurrent` yields zero dispatches and zero advances** | snapshot has several eligible dispatchable items AND several eligible Backlog items; `maxConcurrent=2`, `inFlightCount=2`; drain pre-aborted | `dispatched.length === 0`, `advanced.length === 0`, reconcile still ran (it is unconditional) |
| **AC 4: binding cap — partial in-flight clamps both gates** | snapshot has 5 eligible non-Backlog items + 5 eligible Backlog items; `maxConcurrent=3`, `inFlightCount=1`; drain pre-aborted | `dispatched.length === 2` (capacity = 2), `advanced.length === 2` (decideAutoAdvance internal capacity = 2) |
| **idle: empty board still runs reconcile** | snapshot has no items; `maxConcurrent=2`, `inFlightCount=0`; drain pre-aborted | no dispatches, no advances, reconcile thunks all ran in order |

### What NOT to test

- Do **not** re-test `selectDispatches` or `decideAutoAdvance` semantics (eligibility, wip:* filter, ready:po requirement, blocker filter, exact column types). They are covered exhaustively in `test/pipeline/selection.test.ts` and `test/pipeline/auto-advance.test.ts`. Cycle tests assert orchestration only.
- Do **not** test the four runner internals. Each runner has its own test file (`test/loop/run*.test.ts`); here they are stubbed thunks.
- Do **not** test SIGTERM wiring. The launcher owns that — `runCycle` only sees an `AbortSignal`.
- Do **not** add a "poll interval timing" test. `deps.sleep` is DI'd; the test asserts it was called between ticks, not how long it slept.
- Do **not** add a "fetchSnapshot rejects" case. The ticket's AC list does not include it; one observed failure mode is required before adding a defense (CLAUDE.md "Don't write a defense for a failure mode that hasn't been observed"). The current `tick` body propagates the rejection out of `runCycle` (no try/catch), which is the safe default until a concrete recovery requirement appears.

## Concurrency model

- **Within a tick:** `Promise.allSettled` over `dispatchAgent` calls — true parallel start, sequential await. Subsequent `applyAdvance` calls and the four reconcile thunks are sequential — no parallelism between them. Auto-advance must observe the post-dispatch label state via the next snapshot; reconcile runners share GitHub rate-limit budget and serialising them keeps per-tick burst bounded.
- **Across ticks:** one tick at a time. `runCycle` `await`s `tick` before sleeping. There is no overlapped-ticks mode.
- **Cancellation:** none mid-tick. `AbortSignal` is checked at tick boundaries only (see § "Drain semantics"). `dispatchAgent` does not receive the signal in this revision — adding cancellation to in-flight dispatches would require every downstream salvage / worktree-cleanup path to honour it, which is out of scope and not in any AC.

## Error handling

- `fetchSnapshot` rejection → propagates out of `tick`, out of `runCycle`. The launcher (future ticket) owns the top-level catch + restart policy. `runCycle` does **not** swallow.
- Per-dispatch rejections → isolated by `Promise.allSettled`; the tick continues. Logging is `deps.dispatchAgent`'s responsibility.
- `applyAdvance` rejection → propagates out of `tick`, out of `runCycle`. (Could be wrapped in try/catch in a follow-up if an observed failure mode justifies it; not in this AC list.)
- Maintenance runner rejection → propagates out of `tick`, out of `runCycle`. Same posture — surface failures rather than silently mask them.

The only "swallow" is `Promise.allSettled` on dispatches, and it is required by AC 2. Everywhere else, defaults to throw.

## Open questions

None. The ticket fully specifies the signature, the tick steps and order, the drain semantics, and the four required test cases. The deps shape (snapshot factory, thunked reconcile runners, DI'd `sleep`) is determined by:

- the sibling runners' established narrow-deps idiom (`runDoneCleanup` etc.),
- CLAUDE.md "All external I/O reaches the function through `deps`",
- CLAUDE.md "200-line hardcap".

`pollIntervalMs` is added to `RunCycleConfig` because some inter-tick delay is required (tight loop would burn GraphQL budget) and the value belongs to the launcher's `Config` (`pyryMaxConcurrent` already lives there). The launcher threads it through; no env-var addition in this ticket — that lands when `dispatch-bin.ts` is wired up.

## Out of scope (do not implement here)

- The launcher (`src/dispatch-bin.ts`) wiring — separate ticket. `runCycle` is library code; the binary that consumes it is dispatched independently.
- `deps.dispatchAgent` implementation — the per-agent dispatch surface (worktree create, claude spawn, post-run label delta) is a separate set of tickets under `src/dispatch/`.
- `deps.applyAdvance` implementation — wraps `GitHubProjectClient.setItemStatus` with `issueNumber → itemId` resolution; lands with the launcher.
- A `reconcile()` aggregator function — the four runners are called individually via thunks. Wrapping them adds nothing (no shared state, no shared deps) and would create a new file the maintenance pass is currently not in.
- Per-dispatch cancellation via `AbortSignal` threading into `dispatchAgent` — out of scope per AC list.
- A retry / backoff policy on `fetchSnapshot` failures — no observed failure mode yet (CLAUDE.md "Don't write a defense for a failure mode that hasn't been observed").
- Adding `runCycle` to a barrel/re-export — CLAUDE.md forbids internal barrel imports.

## Definition of done

- `src/loop/cycle.ts` exists, exports `runCycle`, `RunCycleDeps`, `RunCycleConfig`, `CycleSnapshot`. ≤120 lines of production code (target ~85).
- `test/loop/cycle.test.ts` exists with the eight cases above. All green.
- `pnpm typecheck && pnpm test` clean.
- No direct imports of `gh` / `git` / `fs` / `child_process` / `node:fs` / `node:child_process` in `src/loop/cycle.ts` (`rg -n 'from "node:(fs|child_process|os)"' src/loop/cycle.ts` must return zero hits). The four runners stay as siblings — not imported here.
- No edits to `src/pipeline/selection.ts`, `src/pipeline/auto-advance.ts`, `src/pipeline/transitions.ts`, or any `src/loop/run*.ts`. Read-only consumers.
- The `wip:*` predicate is **not** reimplemented in `cycle.ts` (it lives in `selection.ts` / `auto-advance.ts`); `inFlightCount` comes from `deps.fetchSnapshot`.
- Spec file committed alongside the implementation.
