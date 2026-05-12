import { describe, expect, it } from "vitest";
import {
  type Agent,
  decideReworkRouting,
  targetColumnForAgent,
} from "../../src/pipeline/routing.ts";
import { COLUMNS } from "../../src/pipeline/transitions.ts";

// Mirrors the needs-rework:* members of Label in transitions.ts:48-51. If a
// future ticket adds a new needs-rework:<target> to that union, mirror it
// here so the structural-invariant test below catches the drift.
const REWORK_LABELS = [
  "needs-rework:po",
  "needs-rework:architect",
  "needs-rework:developer",
  "needs-rework:code-review",
] as const;

describe("decideReworkRouting — no rework label", () => {
  it.each([
    ["empty input", [] as readonly string[]],
    ["unrelated label only", ["size:s"]],
    ["ready / wip with no rework trigger", ["ready:po", "wip:architect"]],
  ])("returns target=null and stripLabels=[] for %s", (_name, labels) => {
    expect(decideReworkRouting(labels)).toEqual({ target: null, stripLabels: [] });
  });
});

describe("decideReworkRouting — target resolution", () => {
  it.each(REWORK_LABELS)("routes %s to its agent", (label) => {
    const result = decideReworkRouting([label]);
    const expected = label.slice("needs-rework:".length) as Agent;
    expect(result.target).toBe(expected);
  });

  it("structural invariant: every needs-rework:* label resolves to a non-null target equal to its suffix", () => {
    for (const label of REWORK_LABELS) {
      const { target } = decideReworkRouting([label]);
      expect(target).not.toBeNull();
      expect(target).toBe(label.slice("needs-rework:".length));
    }
  });
});

describe("decideReworkRouting — strip contract", () => {
  const fixture = [
    "ready:architect",
    "wip:developer",
    "error:max-turns",
    "needs-rework:architect",
    "size:s",
    "priority:high",
    "security-sensitive",
  ] as const;

  it("includes every ready:*, wip:*, and error:* label", () => {
    const { stripLabels } = decideReworkRouting(fixture);
    expect(stripLabels).toEqual(["ready:architect", "wip:developer", "error:max-turns"]);
  });

  it("does NOT include the needs-rework:<target> label itself", () => {
    const { stripLabels } = decideReworkRouting(fixture);
    expect(stripLabels).not.toContain("needs-rework:architect");
  });

  it("does NOT include non-matching labels (size:*, priority:*, security-sensitive)", () => {
    const { stripLabels } = decideReworkRouting(fixture);
    expect(stripLabels).not.toContain("size:s");
    expect(stripLabels).not.toContain("priority:high");
    expect(stripLabels).not.toContain("security-sensitive");
  });

  it("resolves target to architect for the strip-contract fixture", () => {
    const { target } = decideReworkRouting(fixture);
    expect(target).toBe("architect");
  });
});

describe("decideReworkRouting — edge cases", () => {
  it("multiple needs-rework:* labels — first by input order wins", () => {
    const { target } = decideReworkRouting(["needs-rework:developer", "needs-rework:architect"]);
    expect(target).toBe("developer");
  });

  it("malformed bare 'needs-rework:' (empty suffix) is ignored", () => {
    expect(decideReworkRouting(["needs-rework:"])).toEqual({
      target: null,
      stripLabels: [],
    });
  });
});

describe("targetColumnForAgent", () => {
  it.each([
    ["po", "Backlog"],
    ["architect", "In Architecture"],
    ["developer", "In Development"],
    ["code-review", "In Code Review"],
  ] as const)("maps %s to %s", (agent, expected) => {
    expect(targetColumnForAgent(agent)).toBe(expected);
  });

  it("structural invariant: every needs-rework:* label's agent maps to a known Column", () => {
    for (const label of REWORK_LABELS) {
      const agent = label.slice("needs-rework:".length) as Agent;
      const column = targetColumnForAgent(agent);
      expect(column).toBeTruthy();
      expect(COLUMNS).toContain(column);
    }
  });
});
