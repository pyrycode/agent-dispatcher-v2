import { describe, expect, it } from "vitest";
import {
  type ReworkRoutingDeps,
  type ReworkRoutingItem,
  runReworkRouting,
} from "../../src/loop/runReworkRouting.ts";

// Recording fakes for the narrow ReworkRoutingDeps ports. The runner only
// reads items, removes labels, and sets project status; no transport, no
// real client.
interface Recorder {
  readonly deps: ReworkRoutingDeps;
  readonly removals: Array<{ number: number; name: string }>;
  readonly statusChanges: Array<{ itemId: string; statusName: string }>;
  listCalls: number;
}

function makeRecorder(items: readonly ReworkRoutingItem[]): Recorder {
  const removals: Array<{ number: number; name: string }> = [];
  const statusChanges: Array<{ itemId: string; statusName: string }> = [];
  const recorder: Recorder = {
    removals,
    statusChanges,
    listCalls: 0,
    deps: {
      listItems: async () => {
        recorder.listCalls += 1;
        return items;
      },
      removeLabel: async (number, name) => {
        removals.push({ number, name });
      },
      setItemStatus: async (itemId, statusName) => {
        statusChanges.push({ itemId, statusName });
      },
    },
  };
  return recorder;
}

describe("runReworkRouting", () => {
  it("happy path — strips stale labels and moves ticket to target column", async () => {
    const r = makeRecorder([
      {
        itemId: "I_1",
        issueNumber: 42,
        status: "In Architecture",
        labels: ["needs-rework:po", "ready:architect", "wip:architect", "size:s"],
      },
    ]);
    await runReworkRouting(r.deps);
    expect(r.removals).toEqual([
      { number: 42, name: "ready:architect" },
      { number: 42, name: "wip:architect" },
    ]);
    expect(r.statusChanges).toEqual([{ itemId: "I_1", statusName: "Backlog" }]);
  });

  it("idempotency — same ticket already in target column with only the rework label receives zero mutations", async () => {
    const r = makeRecorder([
      {
        itemId: "I_1",
        issueNumber: 42,
        status: "Backlog",
        labels: ["needs-rework:po", "size:s"],
      },
    ]);
    await runReworkRouting(r.deps);
    expect(r.removals).toEqual([]);
    expect(r.statusChanges).toEqual([]);
    expect(r.listCalls).toBe(1);
  });

  it("no needs-rework:* label — ticket is untouched", async () => {
    const r = makeRecorder([
      {
        itemId: "I_2",
        issueNumber: 7,
        status: "In Architecture",
        labels: ["ready:architect", "size:s"],
      },
    ]);
    await runReworkRouting(r.deps);
    expect(r.removals).toEqual([]);
    expect(r.statusChanges).toEqual([]);
  });

  it("rework label present, stale labels stripped, column already correct — no status mutation", async () => {
    const r = makeRecorder([
      {
        itemId: "I_3",
        issueNumber: 8,
        status: "Backlog",
        labels: ["needs-rework:po", "ready:architect"],
      },
    ]);
    await runReworkRouting(r.deps);
    expect(r.removals).toEqual([{ number: 8, name: "ready:architect" }]);
    expect(r.statusChanges).toEqual([]);
  });

  it("routes multiple items in iteration order", async () => {
    const r = makeRecorder([
      {
        itemId: "I_a",
        issueNumber: 100,
        status: "In Code Review",
        labels: ["needs-rework:developer", "ready:code-review"],
      },
      {
        itemId: "I_b",
        issueNumber: 101,
        status: "In Documentation",
        labels: ["needs-rework:architect"],
      },
    ]);
    await runReworkRouting(r.deps);
    expect(r.removals).toEqual([{ number: 100, name: "ready:code-review" }]);
    expect(r.statusChanges).toEqual([
      { itemId: "I_a", statusName: "In Development" },
      { itemId: "I_b", statusName: "In Architecture" },
    ]);
  });
});
