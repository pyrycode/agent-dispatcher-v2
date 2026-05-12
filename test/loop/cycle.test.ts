import { describe, expect, it } from "vitest";
import {
  type CycleSnapshot,
  type RunCycleConfig,
  type RunCycleDeps,
  runCycle,
} from "../../src/loop/cycle.ts";
import type { AdvanceDecision } from "../../src/pipeline/auto-advance.ts";
import type { DispatchTuple, SelectionItem } from "../../src/pipeline/selection.ts";

// Recording fakes for the narrow RunCycleDeps ports. Tracks dispatches,
// advances, reconcile-runner order, sleep calls, and the fetch-snapshot call
// count. `dispatchAgent` and `applyAdvance` overrides let individual tests
// inject rejections, deferred completions, or drain-trigger side effects.
interface Recorder {
  readonly deps: RunCycleDeps;
  readonly dispatched: DispatchTuple[];
  readonly advanced: AdvanceDecision[];
  readonly reconcileOrder: string[];
  readonly sleeps: number[];
  fetchCalls: number;
}

function makeRecorder(opts: {
  snapshot: CycleSnapshot | (() => Promise<CycleSnapshot>);
  dispatchAgent?: (tuple: DispatchTuple) => Promise<void>;
  applyAdvance?: (decision: AdvanceDecision) => Promise<void>;
  // Optional controller for the drain signal; if provided, sleep aborts it
  // after the first call so the loop exits after exactly one tick.
  abortAfterFirstTick?: AbortController;
}): Recorder {
  const dispatched: DispatchTuple[] = [];
  const advanced: AdvanceDecision[] = [];
  const reconcileOrder: string[] = [];
  const sleeps: number[] = [];
  const recorder: Recorder = {
    dispatched,
    advanced,
    reconcileOrder,
    sleeps,
    fetchCalls: 0,
    deps: {
      fetchSnapshot: async () => {
        recorder.fetchCalls += 1;
        return typeof opts.snapshot === "function" ? await opts.snapshot() : opts.snapshot;
      },
      dispatchAgent: async (tuple) => {
        dispatched.push(tuple);
        if (opts.dispatchAgent) await opts.dispatchAgent(tuple);
      },
      applyAdvance: async (decision) => {
        advanced.push(decision);
        if (opts.applyAdvance) await opts.applyAdvance(decision);
      },
      runDoneCleanup: async () => {
        reconcileOrder.push("doneCleanup");
      },
      runClosedSweep: async () => {
        reconcileOrder.push("closedSweep");
      },
      runAutoMerge: async () => {
        reconcileOrder.push("autoMerge");
      },
      runReworkRouting: async () => {
        reconcileOrder.push("reworkRouting");
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        opts.abortAfterFirstTick?.abort();
      },
    },
  };
  return recorder;
}

function eligible(column: SelectionItem["column"], issueNumber: number): SelectionItem {
  return { column, issueNumber, labels: [], blockers: [] };
}

function backlogReady(issueNumber: number): SelectionItem {
  return {
    column: "Backlog",
    issueNumber,
    labels: ["ready:po"],
    blockers: [],
  };
}

function configWith(opts: {
  maxConcurrent: number;
  drain: AbortSignal;
  pollIntervalMs?: number;
}): RunCycleConfig {
  return {
    maxConcurrent: opts.maxConcurrent,
    pollIntervalMs: opts.pollIntervalMs ?? 100,
    drain: opts.drain,
  };
}

function preAborted(): AbortSignal {
  const c = new AbortController();
  c.abort();
  return c.signal;
}

// Wires drain to abort after the first sleep (i.e., after exactly one tick).
function oneTick(): {
  controller: AbortController;
  recorderOpts: { abortAfterFirstTick: AbortController };
} {
  const controller = new AbortController();
  return { controller, recorderOpts: { abortAfterFirstTick: controller } };
}

describe("runCycle", () => {
  it("tick orchestration: happy path runs all five steps in order", async () => {
    const { controller, recorderOpts } = oneTick();
    const r = makeRecorder({
      snapshot: {
        items: [eligible("In Architecture", 1), backlogReady(2)],
        inFlightCount: 0,
      },
      ...recorderOpts,
    });
    await runCycle(r.deps, configWith({ maxConcurrent: 2, drain: controller.signal }));
    // Both items are dispatchable: the architect column for issue 1 and the
    // po column (Backlog) for issue 2. decideAutoAdvance ALSO promotes the
    // ready:po Backlog item to In Architecture — dispatch + auto-advance
    // both consume the same capacity budget; allocation order is irrelevant
    // because actual_wip = min(...) of the gates, not the sum.
    expect(r.dispatched).toEqual([
      { agent: "architect", issueNumber: 1 },
      { agent: "po", issueNumber: 2 },
    ]);
    expect(r.advanced).toEqual([{ issueNumber: 2, to: "In Architecture" }]);
    expect(r.reconcileOrder).toEqual(["doneCleanup", "closedSweep", "autoMerge", "reworkRouting"]);
  });

  it("Promise.allSettled isolates a rejecting dispatch", async () => {
    const { controller, recorderOpts } = oneTick();
    const r = makeRecorder({
      snapshot: {
        items: [
          eligible("In Architecture", 1),
          eligible("In Development", 2),
          eligible("In Code Review", 3),
        ],
        inFlightCount: 0,
      },
      dispatchAgent: async (tuple) => {
        if (tuple.issueNumber === 2) throw new Error("boom");
      },
      ...recorderOpts,
    });
    await expect(
      runCycle(r.deps, configWith({ maxConcurrent: 3, drain: controller.signal })),
    ).resolves.toBeUndefined();
    expect(r.dispatched.map((t) => t.issueNumber).sort()).toEqual([1, 2, 3]);
    expect(r.reconcileOrder).toEqual(["doneCleanup", "closedSweep", "autoMerge", "reworkRouting"]);
  });

  it("drain raised between ticks stops the loop", async () => {
    const { controller, recorderOpts } = oneTick();
    const r = makeRecorder({
      snapshot: { items: [eligible("In Architecture", 1)], inFlightCount: 0 },
      ...recorderOpts,
    });
    await runCycle(r.deps, configWith({ maxConcurrent: 2, drain: controller.signal }));
    expect(r.fetchCalls).toBe(1);
    expect(r.dispatched.length).toBe(1);
    expect(r.sleeps.length).toBe(1);
  });

  it("drain raised mid-tick still completes in-flight dispatches", async () => {
    const controller = new AbortController();
    const deferreds: Array<{ resolve: () => void; settled: boolean }> = [];
    const r = makeRecorder({
      snapshot: {
        items: [eligible("In Architecture", 1), eligible("In Development", 2)],
        inFlightCount: 0,
      },
      dispatchAgent: (_tuple) => {
        const d: { resolve: () => void; settled: boolean } = {
          resolve: () => {},
          settled: false,
        };
        const promise = new Promise<void>((resolve) => {
          d.resolve = () => {
            d.settled = true;
            resolve();
          };
        });
        deferreds.push(d);
        return promise;
      },
    });
    const runPromise = runCycle(r.deps, configWith({ maxConcurrent: 2, drain: controller.signal }));
    // Yield so dispatchAgent calls have happened.
    await Promise.resolve();
    await Promise.resolve();
    expect(deferreds.length).toBe(2);
    controller.abort();
    // runCycle must not resolve until both deferreds settle.
    for (const d of deferreds) d.resolve();
    await runPromise;
    expect(r.dispatched.length).toBe(2);
    expect(deferreds.every((d) => d.settled)).toBe(true);
    expect(r.fetchCalls).toBe(1);
    expect(r.reconcileOrder).toEqual(["doneCleanup", "closedSweep", "autoMerge", "reworkRouting"]);
  });

  it("drain raised before first tick exits without work", async () => {
    const r = makeRecorder({
      snapshot: { items: [eligible("In Architecture", 1)], inFlightCount: 0 },
    });
    await runCycle(r.deps, configWith({ maxConcurrent: 2, drain: preAborted() }));
    expect(r.fetchCalls).toBe(0);
    expect(r.dispatched).toEqual([]);
    expect(r.advanced).toEqual([]);
    expect(r.reconcileOrder).toEqual([]);
  });

  it("binding cap — inFlightCount === maxConcurrent yields zero dispatches and zero advances", async () => {
    const { controller, recorderOpts } = oneTick();
    const r = makeRecorder({
      snapshot: {
        items: [
          eligible("In Architecture", 1),
          eligible("In Development", 2),
          backlogReady(3),
          backlogReady(4),
        ],
        inFlightCount: 2,
      },
      ...recorderOpts,
    });
    await runCycle(r.deps, configWith({ maxConcurrent: 2, drain: controller.signal }));
    expect(r.dispatched).toEqual([]);
    expect(r.advanced).toEqual([]);
    expect(r.reconcileOrder).toEqual(["doneCleanup", "closedSweep", "autoMerge", "reworkRouting"]);
  });

  it("binding cap — partial in-flight clamps both gates to the same effective capacity", async () => {
    const { controller, recorderOpts } = oneTick();
    const r = makeRecorder({
      snapshot: {
        items: [
          eligible("In Architecture", 1),
          eligible("In Development", 2),
          eligible("In Code Review", 3),
          eligible("In Documentation", 4),
          eligible("In Architecture", 5),
          backlogReady(10),
          backlogReady(11),
          backlogReady(12),
          backlogReady(13),
          backlogReady(14),
        ],
        inFlightCount: 1,
      },
      ...recorderOpts,
    });
    await runCycle(r.deps, configWith({ maxConcurrent: 3, drain: controller.signal }));
    expect(r.dispatched.length).toBe(2);
    expect(r.advanced.length).toBe(2);
  });

  it("idle: empty board still runs reconcile", async () => {
    const { controller, recorderOpts } = oneTick();
    const r = makeRecorder({
      snapshot: { items: [], inFlightCount: 0 },
      ...recorderOpts,
    });
    await runCycle(r.deps, configWith({ maxConcurrent: 2, drain: controller.signal }));
    expect(r.dispatched).toEqual([]);
    expect(r.advanced).toEqual([]);
    expect(r.reconcileOrder).toEqual(["doneCleanup", "closedSweep", "autoMerge", "reworkRouting"]);
    expect(r.fetchCalls).toBe(1);
  });
});
