import { describe, expect, it } from "vitest";
import {
  hasOpenBlockers,
  parseCommitsAhead,
  shouldFlagEmptyBranch,
  shouldProduceCommits,
} from "../../src/pipeline/blockers.ts";

describe("hasOpenBlockers", () => {
  it("returns false for an empty list", () => {
    expect(hasOpenBlockers([])).toBe(false);
  });

  it("returns false when every blocker is closed/merged", () => {
    expect(hasOpenBlockers([{ state: "CLOSED" }, { state: "MERGED" }])).toBe(false);
  });

  it("returns true for a mixed list (one open, one closed)", () => {
    expect(hasOpenBlockers([{ state: "CLOSED" }, { state: "OPEN" }])).toBe(true);
  });

  it("returns true when every blocker is open", () => {
    expect(hasOpenBlockers([{ state: "OPEN" }, { state: "OPEN" }])).toBe(true);
  });

  it("treats unknown states as not-blocking (only OPEN counts)", () => {
    expect(hasOpenBlockers([{ state: "DRAFT" }, { state: "UNKNOWN" }])).toBe(false);
  });
});

describe("parseCommitsAhead", () => {
  it("parses a positive count with trailing newline", () => {
    expect(parseCommitsAhead("5\n")).toBe(5);
  });

  it("parses zero with trailing newline", () => {
    expect(parseCommitsAhead("0\n")).toBe(0);
  });

  it("parses a count without trailing newline", () => {
    expect(parseCommitsAhead("42")).toBe(42);
  });

  it("throws on empty input", () => {
    expect(() => parseCommitsAhead("")).toThrow(/empty output/);
  });

  it("throws on whitespace-only input (empty after trim)", () => {
    expect(() => parseCommitsAhead("\n")).toThrow(/empty output/);
  });

  it("throws on non-numeric input", () => {
    expect(() => parseCommitsAhead("abc")).toThrow(/non-negative integer/);
  });

  it("throws on input that parseInt would silently truncate (regression guard)", () => {
    expect(() => parseCommitsAhead("5abc")).toThrow(/non-negative integer/);
  });

  it("throws on a negative literal", () => {
    expect(() => parseCommitsAhead("-1")).toThrow(/non-negative integer/);
  });
});

describe("shouldFlagEmptyBranch", () => {
  it("returns false when commits exist and no needs-rework label is present (success-with-commits)", () => {
    expect(shouldFlagEmptyBranch({ commitsAhead: 1, labels: [] })).toBe(false);
  });

  it("returns true when no commits and no needs-rework label (silent-fail)", () => {
    expect(shouldFlagEmptyBranch({ commitsAhead: 0, labels: [] })).toBe(true);
  });

  it("returns false when no commits but a needs-rework label is present (deliberate-bail)", () => {
    expect(shouldFlagEmptyBranch({ commitsAhead: 0, labels: ["needs-rework:po"] })).toBe(false);
  });

  it("returns false when commits exist and a needs-rework label is present (partial-bail)", () => {
    expect(shouldFlagEmptyBranch({ commitsAhead: 1, labels: ["needs-rework:po"] })).toBe(false);
  });

  it("treats needs-rework as a prefix match, not a substring match", () => {
    expect(shouldFlagEmptyBranch({ commitsAhead: 0, labels: ["something-needs-rework:po"] })).toBe(
      true,
    );
  });
});

describe("shouldProduceCommits", () => {
  it("architect run produces commits", () => {
    expect(shouldProduceCommits("architect", "run")).toBe(true);
  });

  it("developer run produces commits", () => {
    expect(shouldProduceCommits("developer", "run")).toBe(true);
  });

  it("code-review run produces commits", () => {
    expect(shouldProduceCommits("code-review", "run")).toBe(true);
  });

  it("documentation run produces commits", () => {
    expect(shouldProduceCommits("documentation", "run")).toBe(true);
  });
});
