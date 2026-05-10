import { describe, expect, it } from "vitest";
import {
  type LabelDelta,
  type TransitionState,
  decideLabelDelta,
} from "../../src/pipeline/decisions.ts";
import { TRANSITIONS } from "../../src/pipeline/transitions.ts";

// Per-row representative (before, after) and expected delta. Tests iterate
// TRANSITIONS and look up the expected entry; missing keys fail the suite —
// adding a row to the table without an entry here is a structural gap, not a
// silent miss.
const EXPECTED: Record<
  string,
  { before: TransitionState; after: TransitionState; delta: LabelDelta }
> = {
  // ---------- Forward (happy-path auto-advance) ----------
  "Inbox->Backlog": {
    before: { column: "Inbox", labels: [] },
    after: { column: "Backlog", labels: [] },
    delta: { add: [], remove: [] },
  },
  "Backlog->In Architecture": {
    before: { column: "Backlog", labels: ["ready:po"] },
    after: { column: "In Architecture", labels: ["ready:po"] },
    delta: { add: [], remove: [] },
  },
  "In Architecture->In Development": {
    before: { column: "In Architecture", labels: ["ready:architect"] },
    after: { column: "In Development", labels: ["ready:architect"] },
    delta: { add: [], remove: [] },
  },
  "In Development->In Code Review": {
    before: { column: "In Development", labels: ["ready:developer"] },
    after: { column: "In Code Review", labels: ["ready:developer"] },
    delta: { add: [], remove: [] },
  },
  "In Code Review->In Documentation": {
    before: { column: "In Code Review", labels: ["ready:code-review"] },
    after: { column: "In Documentation", labels: ["ready:code-review"] },
    delta: { add: [], remove: [] },
  },
  "In Documentation->Done": {
    before: { column: "In Documentation", labels: ["ready:documentation"] },
    after: { column: "Done", labels: [] },
    delta: { add: [], remove: ["ready:documentation"] },
  },

  // ---------- Rework (route back to target agent's column) ----------
  "In Architecture->Backlog": {
    before: { column: "In Architecture", labels: ["needs-rework:po"] },
    after: { column: "Backlog", labels: [] },
    delta: { add: [], remove: ["needs-rework:po"] },
  },
  "In Architecture->In Architecture": {
    before: { column: "In Architecture", labels: ["needs-rework:architect"] },
    after: { column: "In Architecture", labels: [] },
    delta: { add: [], remove: ["needs-rework:architect"] },
  },

  "In Development->Backlog": {
    before: { column: "In Development", labels: ["needs-rework:po"] },
    after: { column: "Backlog", labels: [] },
    delta: { add: [], remove: ["needs-rework:po"] },
  },
  "In Development->In Architecture": {
    before: { column: "In Development", labels: ["needs-rework:architect"] },
    after: { column: "In Architecture", labels: [] },
    delta: { add: [], remove: ["needs-rework:architect"] },
  },
  "In Development->In Development": {
    before: { column: "In Development", labels: ["needs-rework:developer"] },
    after: { column: "In Development", labels: [] },
    delta: { add: [], remove: ["needs-rework:developer"] },
  },

  "In Code Review->Backlog": {
    before: { column: "In Code Review", labels: ["needs-rework:po"] },
    after: { column: "Backlog", labels: [] },
    delta: { add: [], remove: ["needs-rework:po"] },
  },
  "In Code Review->In Architecture": {
    before: { column: "In Code Review", labels: ["needs-rework:architect"] },
    after: { column: "In Architecture", labels: [] },
    delta: { add: [], remove: ["needs-rework:architect"] },
  },
  "In Code Review->In Development": {
    before: { column: "In Code Review", labels: ["needs-rework:developer"] },
    after: { column: "In Development", labels: [] },
    delta: { add: [], remove: ["needs-rework:developer"] },
  },
  "In Code Review->In Code Review": {
    before: { column: "In Code Review", labels: ["needs-rework:code-review"] },
    after: { column: "In Code Review", labels: [] },
    delta: { add: [], remove: ["needs-rework:code-review"] },
  },

  "In Documentation->Backlog": {
    before: { column: "In Documentation", labels: ["needs-rework:po"] },
    after: { column: "Backlog", labels: [] },
    delta: { add: [], remove: ["needs-rework:po"] },
  },
  "In Documentation->In Architecture": {
    before: { column: "In Documentation", labels: ["needs-rework:architect"] },
    after: { column: "In Architecture", labels: [] },
    delta: { add: [], remove: ["needs-rework:architect"] },
  },
  "In Documentation->In Development": {
    before: { column: "In Documentation", labels: ["needs-rework:developer"] },
    after: { column: "In Development", labels: [] },
    delta: { add: [], remove: ["needs-rework:developer"] },
  },
  "In Documentation->In Code Review": {
    before: { column: "In Documentation", labels: ["needs-rework:code-review"] },
    after: { column: "In Code Review", labels: [] },
    delta: { add: [], remove: ["needs-rework:code-review"] },
  },
};

describe("decideLabelDelta — per-row coverage of TRANSITIONS", () => {
  it("every TRANSITIONS row has an expected-delta entry (no silent gaps)", () => {
    for (const t of TRANSITIONS) {
      const key = `${t.from}->${t.to}`;
      expect(EXPECTED, `missing expected delta for row ${key}`).toHaveProperty(key);
    }
  });

  it("returns the expected delta for each TRANSITIONS row", () => {
    for (const [key, exp] of Object.entries(EXPECTED)) {
      expect(decideLabelDelta(exp.before, exp.after), `wrong delta for ${key}`).toEqual(exp.delta);
    }
  });
});

describe("decideLabelDelta — illegal transitions throw", () => {
  it.each([
    ["Inbox", "In Architecture"],
    ["Done", "Backlog"],
    ["Backlog", "Done"],
  ] as const)("throws on illegal transition %s -> %s", (from, to) => {
    expect(() =>
      decideLabelDelta({ column: from, labels: [] }, { column: to, labels: [] }),
    ).toThrow(new RegExp(`from "${from}".*to "${to}"`));
  });
});

describe("decideLabelDelta — invariants over every legal transition", () => {
  it("delta.add is always a subset of after.labels (no synthesis)", () => {
    for (const [key, exp] of Object.entries(EXPECTED)) {
      const delta = decideLabelDelta(exp.before, exp.after);
      for (const l of delta.add) {
        expect(exp.after.labels, `synthesized label "${l}" on row ${key}`).toContain(l);
      }
    }
  });

  it("after applying the delta, result has <=1 ready:* and <=1 needs-rework:* label", () => {
    for (const [key, exp] of Object.entries(EXPECTED)) {
      const delta = decideLabelDelta(exp.before, exp.after);
      const removed = new Set<string>(delta.remove);
      const result = [...exp.before.labels.filter((l) => !removed.has(l)), ...delta.add];
      expect(
        result.filter((l) => l.startsWith("ready:")).length,
        `>1 ready:* after applying ${key}`,
      ).toBeLessThanOrEqual(1);
      expect(
        result.filter((l) => l.startsWith("needs-rework:")).length,
        `>1 needs-rework:* after applying ${key}`,
      ).toBeLessThanOrEqual(1);
    }
  });
});
