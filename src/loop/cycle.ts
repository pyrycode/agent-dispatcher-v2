// Main poll loop. Each tick:
//   1. Fetch snapshot (items + in-flight count).
//   2. selectDispatches over remaining capacity.
//   3. Promise.allSettled the selected dispatches.
//   4. decideAutoAdvance + apply each promotion.
//   5. Run the four maintenance routines via deps thunks.
// Drain is an AbortSignal; the launcher wires SIGTERM -> controller.abort().
// On drain, the current tick's in-flight dispatches finish; no new tick
// starts.
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
// passed to selectDispatches AND consumed inside decideAutoAdvance.
//
// All external I/O reaches this function through `deps`, never via direct
// imports. The four maintenance runners are pre-bound thunks so runCycle
// carries no plumbing knowledge of listItems / removeLabel / setItemStatus.

import { type AdvanceDecision, decideAutoAdvance } from "../pipeline/auto-advance.ts";
import { type DispatchTuple, type SelectionItem, selectDispatches } from "../pipeline/selection.ts";

export interface CycleSnapshot {
  readonly items: readonly SelectionItem[];
  readonly inFlightCount: number;
}

export interface RunCycleDeps {
  readonly fetchSnapshot: () => Promise<CycleSnapshot>;
  readonly dispatchAgent: (tuple: DispatchTuple) => Promise<void>;
  readonly applyAdvance: (decision: AdvanceDecision) => Promise<void>;
  readonly runDoneCleanup: () => Promise<void>;
  readonly runClosedSweep: () => Promise<void>;
  readonly runAutoMerge: () => Promise<void>;
  readonly runReworkRouting: () => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface RunCycleConfig {
  readonly maxConcurrent: number;
  readonly pollIntervalMs: number;
  readonly drain: AbortSignal;
}

export async function runCycle(deps: RunCycleDeps, config: RunCycleConfig): Promise<void> {
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
  // continues into auto-advance + reconcile regardless of per-dispatch
  // outcome. Per-dispatch error logging is dispatchAgent's job.
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
