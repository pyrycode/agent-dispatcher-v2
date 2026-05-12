import { describe, expect, it } from "vitest";
import {
  type GateRunner,
  parseSalvageGates,
  shouldAttemptSafeSalvage,
} from "../../src/salvage/gate.ts";

function recordingRunner(codes: Record<string, number>): {
  run: GateRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const run: GateRunner = async (cmd: string) => {
    calls.push(cmd);
    const code = codes[cmd];
    if (code === undefined) throw new Error(`unexpected cmd: ${cmd}`);
    return code;
  };
  return { run, calls };
}

describe("parseSalvageGates", () => {
  it("returns [] for undefined", () => {
    expect(parseSalvageGates(undefined)).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(parseSalvageGates("")).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(parseSalvageGates("   ")).toEqual([]);
  });

  it("returns single command unchanged", () => {
    expect(parseSalvageGates("pnpm typecheck")).toEqual(["pnpm typecheck"]);
  });

  it("splits on semicolons", () => {
    expect(parseSalvageGates("a;b")).toEqual(["a", "b"]);
  });

  it("splits on commas", () => {
    expect(parseSalvageGates("a,b")).toEqual(["a", "b"]);
  });

  it("handles mixed separators and trims whitespace", () => {
    expect(parseSalvageGates("a, b ; c")).toEqual(["a", "b", "c"]);
  });

  it("discards leading and trailing empty segments", () => {
    expect(parseSalvageGates(";a;")).toEqual(["a"]);
  });

  it("discards adjacent-separator empty segments", () => {
    expect(parseSalvageGates(",,a;;b,")).toEqual(["a", "b"]);
  });
});

describe("shouldAttemptSafeSalvage", () => {
  it("returns false for unset gates without invoking the runner", async () => {
    const { run, calls } = recordingRunner({});
    expect(await shouldAttemptSafeSalvage(undefined, run)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("returns false for empty string without invoking the runner", async () => {
    const { run, calls } = recordingRunner({});
    expect(await shouldAttemptSafeSalvage("", run)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("returns false for whitespace-only input without invoking the runner", async () => {
    const { run, calls } = recordingRunner({});
    expect(await shouldAttemptSafeSalvage("   ", run)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("returns true for a single passing gate", async () => {
    const { run, calls } = recordingRunner({ "pnpm typecheck": 0 });
    expect(await shouldAttemptSafeSalvage("pnpm typecheck", run)).toBe(true);
    expect(calls).toEqual(["pnpm typecheck"]);
  });

  it("returns false for a single failing gate", async () => {
    const { run, calls } = recordingRunner({ "pnpm typecheck": 1 });
    expect(await shouldAttemptSafeSalvage("pnpm typecheck", run)).toBe(false);
    expect(calls).toEqual(["pnpm typecheck"]);
  });

  it("returns true when both gates pass, in declaration order", async () => {
    const { run, calls } = recordingRunner({ a: 0, b: 0 });
    expect(await shouldAttemptSafeSalvage("a;b", run)).toBe(true);
    expect(calls).toEqual(["a", "b"]);
  });

  it("short-circuits when the first gate fails", async () => {
    const { run, calls } = recordingRunner({ a: 1, b: 0 });
    expect(await shouldAttemptSafeSalvage("a;b", run)).toBe(false);
    expect(calls).toEqual(["a"]);
  });

  it("returns false when the second gate fails and runs both", async () => {
    const { run, calls } = recordingRunner({ a: 0, b: 2 });
    expect(await shouldAttemptSafeSalvage("a;b", run)).toBe(false);
    expect(calls).toEqual(["a", "b"]);
  });

  it("accepts comma-separated gates", async () => {
    const { run, calls } = recordingRunner({ a: 0, b: 0 });
    expect(await shouldAttemptSafeSalvage("a,b", run)).toBe(true);
    expect(calls).toEqual(["a", "b"]);
  });

  it("accepts semicolon-separated gates", async () => {
    const { run, calls } = recordingRunner({ a: 0, b: 0 });
    expect(await shouldAttemptSafeSalvage("a;b", run)).toBe(true);
    expect(calls).toEqual(["a", "b"]);
  });

  it("trims whitespace around commands before invoking the runner", async () => {
    const { run, calls } = recordingRunner({ a: 0, b: 0 });
    expect(await shouldAttemptSafeSalvage(" a ; b ", run)).toBe(true);
    expect(calls).toEqual(["a", "b"]);
  });
});
