import { describe, expect, it } from "vitest";
import {
  type DoneCleanupDeps,
  type DoneCleanupItem,
  runDoneCleanup,
} from "../../src/loop/runDoneCleanup.ts";

// Recording fakes for the narrow DoneCleanupDeps ports. The runner only
// reads items and removes labels; no transport, no real client.
interface Recorder {
  readonly deps: DoneCleanupDeps;
  readonly removals: Array<{ number: number; name: string }>;
  listCalls: number;
}

function makeRecorder(items: readonly DoneCleanupItem[]): Recorder {
  const removals: Array<{ number: number; name: string }> = [];
  const recorder: Recorder = {
    removals,
    listCalls: 0,
    deps: {
      listItems: async () => {
        recorder.listCalls += 1;
        return items;
      },
      removeLabel: async (number, name) => {
        removals.push({ number, name });
      },
    },
  };
  return recorder;
}

describe("runDoneCleanup", () => {
  it("happy path — strips ready:* and needs-rework:* from a Done ticket", async () => {
    const r = makeRecorder([
      {
        issueNumber: 42,
        status: "Done",
        labels: ["ready:po", "size:s", "needs-rework:architect", "priority:normal"],
      },
    ]);
    await runDoneCleanup(r.deps);
    // Order matches decideLabelDelta's filter walk over before.labels.
    expect(r.removals).toEqual([
      { number: 42, name: "ready:po" },
      { number: 42, name: "needs-rework:architect" },
    ]);
  });

  it("idempotency — Done ticket with no pipeline labels is untouched", async () => {
    const r = makeRecorder([
      { issueNumber: 7, status: "Done", labels: ["size:s", "priority:normal"] },
    ]);
    await runDoneCleanup(r.deps);
    expect(r.removals).toEqual([]);
    expect(r.listCalls).toBe(1);
  });

  it("skips non-Done items entirely", async () => {
    const r = makeRecorder([
      { issueNumber: 1, status: "Done", labels: ["ready:po"] },
      { issueNumber: 2, status: "In Architecture", labels: ["ready:architect"] },
    ]);
    await runDoneCleanup(r.deps);
    expect(r.removals).toEqual([{ number: 1, name: "ready:po" }]);
  });

  it("processes multiple Done items sequentially in iteration order", async () => {
    const r = makeRecorder([
      { issueNumber: 10, status: "Done", labels: ["ready:documentation"] },
      { issueNumber: 11, status: "Done", labels: ["ready:documentation"] },
    ]);
    await runDoneCleanup(r.deps);
    expect(r.removals).toEqual([
      { number: 10, name: "ready:documentation" },
      { number: 11, name: "ready:documentation" },
    ]);
  });
});
