import { describe, expect, it } from "vitest";
import {
  AGENT_COLUMN_MAP,
  type SelectionItem,
  type SelectionState,
  selectDispatches,
} from "../../src/pipeline/selection.ts";

function mkState(items: SelectionItem[]): SelectionState {
  return { items };
}

describe("AGENT_COLUMN_MAP", () => {
  it("maps po to Backlog", () => {
    expect(AGENT_COLUMN_MAP.po).toBe("Backlog");
  });

  it("maps architect to In Architecture", () => {
    expect(AGENT_COLUMN_MAP.architect).toBe("In Architecture");
  });

  it("maps developer to In Development", () => {
    expect(AGENT_COLUMN_MAP.developer).toBe("In Development");
  });

  it("maps code-review to In Code Review", () => {
    expect(AGENT_COLUMN_MAP["code-review"]).toBe("In Code Review");
  });

  it("maps documentation to In Documentation", () => {
    expect(AGENT_COLUMN_MAP.documentation).toBe("In Documentation");
  });

  it("pins the map to exactly five rows (size guard)", () => {
    expect(Object.keys(AGENT_COLUMN_MAP)).toHaveLength(5);
  });
});

describe("selectDispatches — capacity bounds", () => {
  it("returns [] when items is empty", () => {
    expect(selectDispatches(mkState([]), 5)).toEqual([]);
  });

  it("returns [] when maxConcurrent is 0 (non-empty items)", () => {
    const items: SelectionItem[] = [
      { column: "Backlog", issueNumber: 1, labels: [], blockers: [] },
    ];
    expect(selectDispatches(mkState(items), 0)).toEqual([]);
  });

  it("returns [] when maxConcurrent is negative (no-op, not throw)", () => {
    const items: SelectionItem[] = [
      { column: "Backlog", issueNumber: 1, labels: [], blockers: [] },
    ];
    expect(selectDispatches(mkState(items), -1)).toEqual([]);
  });

  it("caps result at 1 when maxConcurrent=1 and 3 items are eligible", () => {
    const items: SelectionItem[] = [
      { column: "Backlog", issueNumber: 1, labels: [], blockers: [] },
      { column: "In Architecture", issueNumber: 2, labels: [], blockers: [] },
      { column: "In Development", issueNumber: 3, labels: [], blockers: [] },
    ];
    expect(selectDispatches(mkState(items), 1)).toHaveLength(1);
  });

  it("returns all 3 when maxConcurrent matches eligible count exactly", () => {
    const items: SelectionItem[] = [
      { column: "Backlog", issueNumber: 1, labels: [], blockers: [] },
      { column: "In Architecture", issueNumber: 2, labels: [], blockers: [] },
      { column: "In Development", issueNumber: 3, labels: [], blockers: [] },
    ];
    expect(selectDispatches(mkState(items), 3)).toHaveLength(3);
  });

  it("returns 3 when maxConcurrent exceeds eligible count (beyond-N)", () => {
    const items: SelectionItem[] = [
      { column: "Backlog", issueNumber: 1, labels: [], blockers: [] },
      { column: "In Architecture", issueNumber: 2, labels: [], blockers: [] },
      { column: "In Development", issueNumber: 3, labels: [], blockers: [] },
    ];
    expect(selectDispatches(mkState(items), 5)).toHaveLength(3);
  });

  it("preserves input order (caller-supplied priority)", () => {
    const items: SelectionItem[] = [
      { column: "In Development", issueNumber: 30, labels: [], blockers: [] },
      { column: "Backlog", issueNumber: 10, labels: [], blockers: [] },
      { column: "In Architecture", issueNumber: 20, labels: [], blockers: [] },
    ];
    const result = selectDispatches(mkState(items), 5);
    expect(result.map((t) => t.issueNumber)).toEqual([30, 10, 20]);
  });
});

describe("selectDispatches — wip-gate exclusion", () => {
  it("excludes an item carrying wip:architect", () => {
    const items: SelectionItem[] = [
      {
        column: "In Architecture",
        issueNumber: 1,
        labels: ["wip:architect"],
        blockers: [],
      },
    ];
    expect(selectDispatches(mkState(items), 5)).toEqual([]);
  });

  it("excludes any wip:* prefix, even an unknown agent suffix", () => {
    const items: SelectionItem[] = [
      { column: "Backlog", issueNumber: 1, labels: ["wip:foo"], blockers: [] },
    ];
    expect(selectDispatches(mkState(items), 5)).toEqual([]);
  });

  it("treats wip: as a prefix match, not a substring (something-wip:bar does NOT exclude)", () => {
    const items: SelectionItem[] = [
      {
        column: "Backlog",
        issueNumber: 1,
        labels: ["something-wip:bar"],
        blockers: [],
      },
    ];
    expect(selectDispatches(mkState(items), 5)).toEqual([{ agent: "po", issueNumber: 1 }]);
  });
});

describe("selectDispatches — blocker-gate exclusion", () => {
  it("excludes an item with one OPEN blocker", () => {
    const items: SelectionItem[] = [
      {
        column: "Backlog",
        issueNumber: 1,
        labels: [],
        blockers: [{ state: "OPEN" }],
      },
    ];
    expect(selectDispatches(mkState(items), 5)).toEqual([]);
  });

  it("includes the same item if the blocker is CLOSED", () => {
    const items: SelectionItem[] = [
      {
        column: "Backlog",
        issueNumber: 1,
        labels: [],
        blockers: [{ state: "CLOSED" }],
      },
    ];
    expect(selectDispatches(mkState(items), 5)).toEqual([{ agent: "po", issueNumber: 1 }]);
  });

  it("excludes when at least one blocker is OPEN among mixed states", () => {
    const items: SelectionItem[] = [
      {
        column: "Backlog",
        issueNumber: 1,
        labels: [],
        blockers: [{ state: "OPEN" }, { state: "CLOSED" }],
      },
    ];
    expect(selectDispatches(mkState(items), 5)).toEqual([]);
  });

  it("includes an item with empty blockers", () => {
    const items: SelectionItem[] = [
      { column: "Backlog", issueNumber: 1, labels: [], blockers: [] },
    ];
    expect(selectDispatches(mkState(items), 5)).toEqual([{ agent: "po", issueNumber: 1 }]);
  });
});

describe("selectDispatches — per-issue label scoping", () => {
  it("a wip:* on item A does not gate item B", () => {
    const items: SelectionItem[] = [
      {
        column: "In Architecture",
        issueNumber: 1,
        labels: ["wip:architect"],
        blockers: [],
      },
      { column: "Backlog", issueNumber: 2, labels: [], blockers: [] },
    ];
    const result = selectDispatches(mkState(items), 5);
    expect(result).toEqual([{ agent: "po", issueNumber: 2 }]);
  });

  it("an OPEN blocker on item A does not gate item B", () => {
    const items: SelectionItem[] = [
      {
        column: "In Architecture",
        issueNumber: 1,
        labels: [],
        blockers: [{ state: "OPEN" }],
      },
      { column: "Backlog", issueNumber: 2, labels: [], blockers: [] },
    ];
    const result = selectDispatches(mkState(items), 5);
    expect(result).toEqual([{ agent: "po", issueNumber: 2 }]);
  });
});

describe("selectDispatches — column → agent mapping", () => {
  it("emits the right (agent, issueNumber) tuple for one item per consuming column", () => {
    const items: SelectionItem[] = [
      { column: "Backlog", issueNumber: 1, labels: [], blockers: [] },
      { column: "In Architecture", issueNumber: 2, labels: [], blockers: [] },
      { column: "In Development", issueNumber: 3, labels: [], blockers: [] },
      { column: "In Code Review", issueNumber: 4, labels: [], blockers: [] },
      { column: "In Documentation", issueNumber: 5, labels: [], blockers: [] },
    ];
    expect(selectDispatches(mkState(items), 5)).toEqual([
      { agent: "po", issueNumber: 1 },
      { agent: "architect", issueNumber: 2 },
      { agent: "developer", issueNumber: 3 },
      { agent: "code-review", issueNumber: 4 },
      { agent: "documentation", issueNumber: 5 },
    ]);
  });

  it("silently skips items in Inbox (no consuming agent)", () => {
    const items: SelectionItem[] = [
      { column: "Inbox", issueNumber: 1, labels: [], blockers: [] },
      { column: "Backlog", issueNumber: 2, labels: [], blockers: [] },
    ];
    expect(selectDispatches(mkState(items), 5)).toEqual([{ agent: "po", issueNumber: 2 }]);
  });

  it("silently skips items in Done (terminal column, no consuming agent)", () => {
    const items: SelectionItem[] = [
      { column: "Done", issueNumber: 1, labels: [], blockers: [] },
      { column: "Backlog", issueNumber: 2, labels: [], blockers: [] },
    ];
    expect(selectDispatches(mkState(items), 5)).toEqual([{ agent: "po", issueNumber: 2 }]);
  });

  it("does not consume capacity for skipped (Inbox/Done) items", () => {
    const items: SelectionItem[] = [
      { column: "Inbox", issueNumber: 1, labels: [], blockers: [] },
      { column: "Done", issueNumber: 2, labels: [], blockers: [] },
      { column: "Backlog", issueNumber: 3, labels: [], blockers: [] },
    ];
    expect(selectDispatches(mkState(items), 1)).toEqual([{ agent: "po", issueNumber: 3 }]);
  });
});
