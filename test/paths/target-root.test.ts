import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTargetRoot } from "../../src/paths/target-root.ts";

describe("resolveTargetRoot", () => {
  it("env override wins when both env and agentsRoot are non-empty", () => {
    expect(
      resolveTargetRoot({ envValue: "/from/env/target", agentsRoot: "/work/pyrycode/agents" }),
    ).toBe(resolve("/from/env/target"));
  });

  it("empty-string env falls through to parent-of(agentsRoot)", () => {
    expect(resolveTargetRoot({ envValue: "", agentsRoot: "/work/pyrycode/agents" })).toBe(
      resolve("/work/pyrycode"),
    );
  });

  it("undefined env falls through to parent-of(agentsRoot)", () => {
    expect(resolveTargetRoot({ envValue: undefined, agentsRoot: "/work/pyrycode/agents" })).toBe(
      resolve("/work/pyrycode"),
    );
  });

  it("works for any consumer (pyrycode-mobile)", () => {
    expect(
      resolveTargetRoot({ envValue: undefined, agentsRoot: "/work/pyrycode-mobile/agents" }),
    ).toBe(resolve("/work/pyrycode-mobile"));
  });

  it("works for any consumer (pyrycode-relay)", () => {
    expect(
      resolveTargetRoot({ envValue: undefined, agentsRoot: "/work/pyrycode-relay/agents" }),
    ).toBe(resolve("/work/pyrycode-relay"));
  });

  it("does NOT reintroduce the pyrycode/pyrycode/ bug (target = parent, not sibling)", () => {
    const target = resolveTargetRoot({
      envValue: undefined,
      agentsRoot: "/work/pyrycode/agents",
    });
    expect(target).toBe(resolve("/work/pyrycode"));
    expect(target).not.toBe(resolve("/work/pyrycode/pyrycode"));
  });

  it("normalizes the env path (resolves .. segments)", () => {
    expect(
      resolveTargetRoot({ envValue: "/foo/../bar", agentsRoot: "/work/pyrycode/agents" }),
    ).toBe(resolve("/bar"));
  });

  it("throws naming TARGET_REPO_PATH when both env and agentsRoot are unset", () => {
    expect(() => resolveTargetRoot({ envValue: undefined, agentsRoot: undefined })).toThrow(
      /TARGET_REPO_PATH/,
    );
  });

  it("throws when both are empty strings", () => {
    expect(() => resolveTargetRoot({ envValue: "", agentsRoot: "" })).toThrow(/TARGET_REPO_PATH/);
  });
});
