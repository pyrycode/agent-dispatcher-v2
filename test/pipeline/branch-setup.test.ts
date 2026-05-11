import { describe, expect, it } from "vitest";
import { decideBranchSetup, shouldAutoCommit } from "../../src/pipeline/branch-setup.ts";

describe("decideBranchSetup", () => {
  it("creates feature/<n> when no PR exists and no needs-rework label is present", () => {
    expect(decideBranchSetup({ issueNumber: 42, labels: [], existingPrHeadRef: null })).toEqual({
      kind: "create",
      branch: "feature/42",
    });
  });

  it("creates feature/<n> when no PR exists, regardless of needs-rework label", () => {
    expect(
      decideBranchSetup({
        issueNumber: 42,
        labels: ["needs-rework:po"],
        existingPrHeadRef: null,
      }),
    ).toEqual({ kind: "create", branch: "feature/42" });
  });

  it("reuses the existing PR head ref when a PR exists and no needs-rework label is present", () => {
    expect(
      decideBranchSetup({ issueNumber: 42, labels: [], existingPrHeadRef: "feature/42" }),
    ).toEqual({ kind: "reuse", branch: "feature/42" });
  });

  it("reuses the existing PR head ref when a PR exists and a needs-rework label is present", () => {
    expect(
      decideBranchSetup({
        issueNumber: 42,
        labels: ["needs-rework:po"],
        existingPrHeadRef: "feature/42",
      }),
    ).toEqual({ kind: "reuse", branch: "feature/42" });
  });

  it("formats the branch as feature/<issueNumber> (template-string format guard)", () => {
    expect(decideBranchSetup({ issueNumber: 7, labels: [], existingPrHeadRef: null }).branch).toBe(
      "feature/7",
    );
  });
});

describe("shouldAutoCommit", () => {
  it("returns false when a commit already exists (no needs-rework label)", () => {
    expect(shouldAutoCommit({ commitsAhead: 1, stagedChangesPresent: true, labels: [] })).toBe(
      false,
    );
  });

  it("returns false when a commit already exists and a needs-rework label is present", () => {
    expect(
      shouldAutoCommit({
        commitsAhead: 1,
        stagedChangesPresent: true,
        labels: ["needs-rework:po"],
      }),
    ).toBe(false);
  });

  it("returns false when no commits and no staged changes (silent-fail — shouldFlagEmptyBranch's domain)", () => {
    expect(shouldAutoCommit({ commitsAhead: 0, stagedChangesPresent: false, labels: [] })).toBe(
      false,
    );
  });

  it("returns false when no commits, no staged changes, and a needs-rework label is present", () => {
    expect(
      shouldAutoCommit({
        commitsAhead: 0,
        stagedChangesPresent: false,
        labels: ["needs-rework:po"],
      }),
    ).toBe(false);
  });

  it("returns true when no commits but staged changes are present and no needs-rework label (silent-success-with-staged-changes — safety net fires)", () => {
    expect(shouldAutoCommit({ commitsAhead: 0, stagedChangesPresent: true, labels: [] })).toBe(
      true,
    );
  });

  it("returns false when no commits, staged changes present, and a needs-rework label is present (deliberate bail)", () => {
    expect(
      shouldAutoCommit({
        commitsAhead: 0,
        stagedChangesPresent: true,
        labels: ["needs-rework:po"],
      }),
    ).toBe(false);
  });

  it("treats needs-rework as a prefix match, not a substring match", () => {
    expect(
      shouldAutoCommit({
        commitsAhead: 0,
        stagedChangesPresent: true,
        labels: ["something-needs-rework:po"],
      }),
    ).toBe(true);
  });
});
