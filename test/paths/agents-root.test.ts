import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentsRoot } from "../../src/paths/agents-root.ts";

describe("resolveAgentsRoot", () => {
  it("env override wins when both env and fallback are non-empty", () => {
    expect(
      resolveAgentsRoot({ envValue: "/from/env/agents", fallback: "/from/fallback/agents" }),
    ).toBe(resolve("/from/env/agents"));
  });

  it("empty-string env falls through to fallback", () => {
    expect(resolveAgentsRoot({ envValue: "", fallback: "/from/fallback/agents" })).toBe(
      resolve("/from/fallback/agents"),
    );
  });

  it("undefined env falls through to fallback", () => {
    expect(resolveAgentsRoot({ envValue: undefined, fallback: "/from/fallback/agents" })).toBe(
      resolve("/from/fallback/agents"),
    );
  });

  it("normalizes the fallback path (resolves .. segments)", () => {
    expect(resolveAgentsRoot({ envValue: undefined, fallback: "/foo/../bar" })).toBe(
      resolve("/bar"),
    );
  });

  it("normalizes the env path (resolves .. segments)", () => {
    expect(resolveAgentsRoot({ envValue: "/foo/../bar", fallback: undefined })).toBe(
      resolve("/bar"),
    );
  });

  it("throws naming AGENTS_REPO_PATH when both are unset", () => {
    expect(() => resolveAgentsRoot({ envValue: undefined, fallback: undefined })).toThrow(
      /AGENTS_REPO_PATH/,
    );
  });

  it("throws when both are empty strings", () => {
    expect(() => resolveAgentsRoot({ envValue: "", fallback: "" })).toThrow(/AGENTS_REPO_PATH/);
  });

  it("does not strip a trailing path segment from the fallback (v1 c72adb4 lock-in)", () => {
    expect(resolveAgentsRoot({ envValue: undefined, fallback: "/work/pyrycode/agents" })).toBe(
      resolve("/work/pyrycode/agents"),
    );
  });
});
