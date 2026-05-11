import { describe, expect, it } from "vitest";
import { type AutoAdvanceState, decideAutoAdvance } from "../../src/pipeline/auto-advance.ts";
import type { SelectionItem } from "../../src/pipeline/selection.ts";

function mkState(items: SelectionItem[]): AutoAdvanceState {
  return { items };
}

function eligible(issueNumber: number): SelectionItem {
  return {
    column: "Backlog",
    issueNumber,
    labels: ["ready:po"],
    blockers: [],
  };
}

describe("decideAutoAdvance — capacity bounds", () => {
  it("both-advance-same-cycle: two eligible, maxConcurrent=2, inFlightCount=0", () => {
    const items: SelectionItem[] = [eligible(1), eligible(2)];
    expect(decideAutoAdvance(mkState(items), 0, 2)).toEqual([
      { issueNumber: 1, to: "In Architecture" },
      { issueNumber: 2, to: "In Architecture" },
    ]);
  });

  it("partial-in-flight-reduces-capacity: 3 eligible, maxConcurrent=3, inFlightCount=1", () => {
    const items: SelectionItem[] = [eligible(1), eligible(2), eligible(3)];
    expect(decideAutoAdvance(mkState(items), 1, 3)).toEqual([
      { issueNumber: 1, to: "In Architecture" },
      { issueNumber: 2, to: "In Architecture" },
    ]);
  });

  it("capacity-saturated-holds-all: inFlightCount === maxConcurrent", () => {
    const items: SelectionItem[] = [eligible(1), eligible(2)];
    expect(decideAutoAdvance(mkState(items), 2, 2)).toEqual([]);
  });

  it("transient-over-capacity-clamp: inFlightCount > maxConcurrent", () => {
    const items: SelectionItem[] = [eligible(1)];
    expect(decideAutoAdvance(mkState(items), 5, 2)).toEqual([]);
  });

  it("max-zero-boundary: maxConcurrent=0 yields [] regardless of inputs", () => {
    const items: SelectionItem[] = [eligible(1), eligible(2)];
    expect(decideAutoAdvance(mkState(items), 0, 0)).toEqual([]);
    expect(decideAutoAdvance(mkState(items), 7, 0)).toEqual([]);
    expect(decideAutoAdvance(mkState([]), 0, 0)).toEqual([]);
  });
});

describe("decideAutoAdvance — ineligibility filters", () => {
  it("skips a Backlog item missing ready:po", () => {
    const items: SelectionItem[] = [
      { column: "Backlog", issueNumber: 1, labels: [], blockers: [] },
    ];
    expect(decideAutoAdvance(mkState(items), 0, 5)).toEqual([]);
  });

  it("skips a Backlog item carrying a wip:* label", () => {
    const items: SelectionItem[] = [
      {
        column: "Backlog",
        issueNumber: 1,
        labels: ["ready:po", "wip:architect"],
        blockers: [],
      },
    ];
    expect(decideAutoAdvance(mkState(items), 0, 5)).toEqual([]);
  });

  it("skips a Backlog item with an open blocker", () => {
    const items: SelectionItem[] = [
      {
        column: "Backlog",
        issueNumber: 1,
        labels: ["ready:po"],
        blockers: [{ state: "OPEN" }],
      },
    ];
    expect(decideAutoAdvance(mkState(items), 0, 5)).toEqual([]);
  });

  it("skips an item in a non-Backlog column even with ready:po", () => {
    const items: SelectionItem[] = [
      {
        column: "In Architecture",
        issueNumber: 1,
        labels: ["ready:po"],
        blockers: [],
      },
    ];
    expect(decideAutoAdvance(mkState(items), 0, 5)).toEqual([]);
  });
});
