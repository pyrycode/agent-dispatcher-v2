import { describe, expect, it } from "vitest";
import {
  type ClosedSweepDeps,
  type ClosedSweepItem,
  runClosedSweep,
} from "../../src/loop/runClosedSweep.ts";

// Recording fakes for the narrow ClosedSweepDeps ports. The runner only
// reads items and moves their Status to Done; no transport, no real client.
interface Recorder {
  readonly deps: ClosedSweepDeps;
  readonly statusSets: Array<{ itemId: string }>;
  listCalls: number;
}

function makeRecorder(items: readonly ClosedSweepItem[]): Recorder {
  const statusSets: Array<{ itemId: string }> = [];
  const recorder: Recorder = {
    statusSets,
    listCalls: 0,
    deps: {
      listItems: async () => {
        recorder.listCalls += 1;
        return items;
      },
      setItemStatusToDone: async (itemId) => {
        statusSets.push({ itemId });
      },
    },
  };
  return recorder;
}

describe("runClosedSweep", () => {
  it("happy path — CLOSED issue in In Code Review is moved to Done", async () => {
    const r = makeRecorder([
      { id: "PVTI_1", issueNumber: 42, status: "In Code Review", state: "CLOSED" },
    ]);
    await runClosedSweep(r.deps);
    expect(r.statusSets).toEqual([{ itemId: "PVTI_1" }]);
  });

  it("idempotency — CLOSED issue already in Done is untouched", async () => {
    const r = makeRecorder([{ id: "PVTI_2", issueNumber: 7, status: "Done", state: "CLOSED" }]);
    await runClosedSweep(r.deps);
    expect(r.statusSets).toEqual([]);
    expect(r.listCalls).toBe(1);
  });

  it("OPEN items in pre-Done columns are skipped", async () => {
    const r = makeRecorder([
      { id: "PVTI_3", issueNumber: 99, status: "In Code Review", state: "OPEN" },
    ]);
    await runClosedSweep(r.deps);
    expect(r.statusSets).toEqual([]);
  });

  it("mixed batch — only CLOSED items in pre-Done columns are moved, in iteration order", async () => {
    const r = makeRecorder([
      { id: "PVTI_a", issueNumber: 10, status: "In Code Review", state: "CLOSED" },
      { id: "PVTI_b", issueNumber: 11, status: "Done", state: "CLOSED" },
      { id: "PVTI_c", issueNumber: 12, status: "In Architecture", state: "OPEN" },
      { id: "PVTI_d", issueNumber: 13, status: "In Documentation", state: "CLOSED" },
    ]);
    await runClosedSweep(r.deps);
    expect(r.statusSets).toEqual([{ itemId: "PVTI_a" }, { itemId: "PVTI_d" }]);
  });
});
