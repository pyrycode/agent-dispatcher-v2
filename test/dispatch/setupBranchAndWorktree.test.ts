import { describe, expect, it } from "vitest";
import { setupBranchAndWorktree } from "../../src/dispatch/setupBranchAndWorktree.ts";
import type { DispatchState } from "../../src/dispatch/state.ts";

function fakeDeps(opts: {
  existingPrHeadRef: string | null;
  worktreePath?: string;
  onLookup?: (issueNumber: number) => void;
  onCreate?: (branch: string) => void;
  lookupThrows?: Error;
  createThrows?: Error;
}) {
  const calls = { lookup: [] as number[], create: [] as string[] };
  const deps = {
    lookupExistingPrHeadRef: async (n: number): Promise<string | null> => {
      calls.lookup.push(n);
      opts.onLookup?.(n);
      if (opts.lookupThrows) throw opts.lookupThrows;
      return opts.existingPrHeadRef;
    },
    createWorktree: async (branch: string): Promise<string> => {
      calls.create.push(branch);
      opts.onCreate?.(branch);
      if (opts.createThrows) throw opts.createThrows;
      return opts.worktreePath ?? `/tmp/${branch.replace("/", "-")}`;
    },
  };
  return { calls, deps };
}

function makeState(overrides?: Partial<DispatchState>): DispatchState {
  return {
    agent: "developer",
    issueNumber: 42,
    worktreePath: "/tmp/wt-42",
    args: [],
    ...overrides,
  };
}

describe("setupBranchAndWorktree", () => {
  it("reuse path: lookup returns existing PR head ref → kind 'reuse', branch is that ref", async () => {
    const { calls, deps } = fakeDeps({
      existingPrHeadRef: "feature/42",
      worktreePath: "/tmp/wt-42",
    });

    const result = await setupBranchAndWorktree(makeState(), deps);

    expect(result).toEqual({
      branch: "feature/42",
      worktreePath: "/tmp/wt-42",
      kind: "reuse",
    });
    expect(calls.lookup).toEqual([42]);
    expect(calls.create).toEqual(["feature/42"]);
  });

  it("create path: lookup returns null → kind 'create', branch is feature/<issueNumber>", async () => {
    const { calls, deps } = fakeDeps({
      existingPrHeadRef: null,
      worktreePath: "/tmp/wt-fresh",
    });

    const result = await setupBranchAndWorktree(makeState(), deps);

    expect(result).toEqual({
      branch: "feature/42",
      worktreePath: "/tmp/wt-fresh",
      kind: "create",
    });
    expect(calls.lookup).toEqual([42]);
    expect(calls.create).toEqual(["feature/42"]);
  });

  it("load-bearing ordering: lookup runs before create (no parallel/reordered execution)", async () => {
    const events: string[] = [];
    const { deps } = fakeDeps({
      existingPrHeadRef: null,
      onLookup: () => {
        events.push("lookup");
      },
      onCreate: () => {
        events.push("create");
      },
    });

    await setupBranchAndWorktree(makeState(), deps);

    expect(events).toEqual(["lookup", "create"]);
  });

  it("lookup throws → createWorktree never invoked; throw rethrows verbatim", async () => {
    const { calls, deps } = fakeDeps({
      existingPrHeadRef: null,
      lookupThrows: new Error("HTTP 500: pr lookup failed"),
    });

    await expect(setupBranchAndWorktree(makeState(), deps)).rejects.toThrow(
      "HTTP 500: pr lookup failed",
    );

    expect(calls.lookup.length).toBe(1);
    expect(calls.create.length).toBe(0);
  });

  it("createWorktree throws after lookup succeeded → rethrows; lookup call still happened", async () => {
    const { calls, deps } = fakeDeps({
      existingPrHeadRef: null,
      createThrows: new Error("git: worktree path collision"),
    });

    await expect(setupBranchAndWorktree(makeState(), deps)).rejects.toThrow(
      "git: worktree path collision",
    );

    expect(calls.lookup.length).toBe(1);
    expect(calls.create.length).toBe(1);
  });
});
