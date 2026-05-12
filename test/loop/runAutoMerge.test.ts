import { describe, expect, it } from "vitest";
import type { MergeResult } from "../../src/github/pr.ts";
import {
  type AutoMergeDeps,
  type AutoMergeItem,
  runAutoMerge,
} from "../../src/loop/runAutoMerge.ts";
import type { ReadyPrCandidate } from "../../src/pipeline/find-ready-pr.ts";

function mkPr(number: number, isDraft = false, labels: readonly string[] = []): ReadyPrCandidate {
  return {
    number,
    nodeId: `node-${number}`,
    url: `https://example/${number}`,
    isDraft,
    labels,
  };
}

interface Recorder {
  readonly deps: AutoMergeDeps;
  readonly mergeCalls: number[];
  readonly rollbacks: Array<{ itemId: string }>;
  listCalls: number;
}

function makeRecorder(
  items: readonly AutoMergeItem[],
  prsByIssue: Record<number, readonly ReadyPrCandidate[]>,
  mergeResults: Record<number, MergeResult>,
): Recorder {
  const mergeCalls: number[] = [];
  const rollbacks: Array<{ itemId: string }> = [];
  const recorder: Recorder = {
    mergeCalls,
    rollbacks,
    listCalls: 0,
    deps: {
      listItems: async () => {
        recorder.listCalls += 1;
        return items;
      },
      listPrsForItem: async (item) => prsByIssue[item.issueNumber] ?? [],
      mergePr: async (prNumber) => {
        mergeCalls.push(prNumber);
        const result = mergeResults[prNumber];
        if (!result) {
          throw new Error(`unexpected mergePr call for ${prNumber}`);
        }
        return result;
      },
      setItemStatusToInCodeReview: async (itemId) => {
        rollbacks.push({ itemId });
      },
    },
  };
  return recorder;
}

describe("runAutoMerge", () => {
  it("happy path — ready PR merges, ticket stays in Done", async () => {
    const r = makeRecorder(
      [{ id: "PVTI_1", issueNumber: 42, status: "Done" }],
      { 42: [mkPr(101)] },
      { 101: { merged: true } },
    );
    await runAutoMerge(r.deps);
    expect(r.mergeCalls).toEqual([101]);
    expect(r.rollbacks).toEqual([]);
  });

  it("conflict rollback — Status moves back to In Code Review", async () => {
    const r = makeRecorder(
      [{ id: "PVTI_2", issueNumber: 43, status: "Done" }],
      { 43: [mkPr(102)] },
      { 102: { merged: false, reason: "conflict", error: new Error("merge conflict") } },
    );
    await runAutoMerge(r.deps);
    expect(r.mergeCalls).toEqual([102]);
    expect(r.rollbacks).toEqual([{ itemId: "PVTI_2" }]);
  });

  it("idempotency — Done item whose PR is already merged (no candidates) is a no-op", async () => {
    const r = makeRecorder([{ id: "PVTI_3", issueNumber: 44, status: "Done" }], { 44: [] }, {});
    await runAutoMerge(r.deps);
    expect(r.mergeCalls).toEqual([]);
    expect(r.rollbacks).toEqual([]);
    expect(r.listCalls).toBe(1);
  });

  it("idempotency — Done item whose only candidate is a draft is a no-op", async () => {
    const r = makeRecorder(
      [{ id: "PVTI_4", issueNumber: 45, status: "Done" }],
      { 45: [mkPr(103, true)] },
      {},
    );
    await runAutoMerge(r.deps);
    expect(r.mergeCalls).toEqual([]);
    expect(r.rollbacks).toEqual([]);
    expect(r.listCalls).toBe(1);
  });

  it("non-Done items are skipped — no listPrsForItem, no merge, no rollback", async () => {
    const r = makeRecorder(
      [{ id: "PVTI_5", issueNumber: 46, status: "In Code Review" }],
      { 46: [mkPr(104)] },
      { 104: { merged: true } },
    );
    await runAutoMerge(r.deps);
    expect(r.mergeCalls).toEqual([]);
    expect(r.rollbacks).toEqual([]);
  });

  it("reason: 'other' does NOT trigger rollback", async () => {
    const r = makeRecorder(
      [{ id: "PVTI_6", issueNumber: 47, status: "Done" }],
      { 47: [mkPr(105)] },
      { 105: { merged: false, reason: "other", error: new Error("rate limit") } },
    );
    await runAutoMerge(r.deps);
    expect(r.mergeCalls).toEqual([105]);
    expect(r.rollbacks).toEqual([]);
  });

  it("mixed batch — sweep does not abort early on a per-item rollback", async () => {
    const r = makeRecorder(
      [
        { id: "PVTI_a", issueNumber: 50, status: "Done" },
        { id: "PVTI_b", issueNumber: 51, status: "Done" },
      ],
      { 50: [mkPr(200)], 51: [mkPr(201)] },
      {
        200: { merged: true },
        201: { merged: false, reason: "conflict", error: new Error("merge conflict") },
      },
    );
    await runAutoMerge(r.deps);
    expect(r.mergeCalls).toEqual([200, 201]);
    expect(r.rollbacks).toEqual([{ itemId: "PVTI_b" }]);
  });
});
