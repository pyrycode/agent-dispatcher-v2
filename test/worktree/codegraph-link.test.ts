import { describe, expect, it } from "vitest";
import {
  NOOP_ALREADY_CORRECT,
  NOOP_TARGET_MISSING,
  type SymlinkAction,
  type SymlinkFs,
  applyCodegraphSymlinkActions,
  decideCodegraphSymlink,
} from "../../src/worktree/codegraph-link.ts";

const WORKTREE_ROOT = "/tmp/.pyrycode-worktrees/dev-45";
const TARGET_CODEGRAPH = "/Users/foo/repo/.codegraph";
const EXPECTED_TO = "/tmp/.pyrycode-worktrees/dev-45/.codegraph";

// Routing-table recording fake — fs-shaped sibling of `makeSpawn` from
// test/worktree/cleanup.test.ts. The `calls` log is the verification mechanism
// for the AC's "no real symlinks created on the test host's filesystem" pin.
type FsRoute =
  | {
      op: "symlink";
      match: (target: string, p: string) => boolean;
      respond?: () => void | Promise<void>;
    }
  | { op: "unlink"; match: (p: string) => boolean; respond?: () => void | Promise<void> };

interface RecordingFs {
  fs: SymlinkFs;
  calls: Array<["symlink", string, string] | ["unlink", string]>;
}

function makeFs(routes: readonly FsRoute[]): RecordingFs {
  const calls: RecordingFs["calls"] = [];
  const fs: SymlinkFs = {
    symlink: async (target, p) => {
      calls.push(["symlink", target, p]);
      for (const r of routes) {
        if (r.op === "symlink" && r.match(target, p)) return r.respond?.();
      }
      throw new Error(`No route matched: symlink(${target}, ${p})`);
    },
    unlink: async (p) => {
      calls.push(["unlink", p]);
      for (const r of routes) {
        if (r.op === "unlink" && r.match(p)) return r.respond?.();
      }
      throw new Error(`No route matched: unlink(${p})`);
    },
  };
  return { fs, calls };
}

describe("decideCodegraphSymlink", () => {
  it("absent → single create action", () => {
    const actions = decideCodegraphSymlink({
      worktreeRoot: WORKTREE_ROOT,
      targetCodegraphPath: TARGET_CODEGRAPH,
      state: { kind: "absent" },
    });
    expect(actions).toEqual([{ kind: "create", from: TARGET_CODEGRAPH, to: EXPECTED_TO }]);
  });

  it("present-correct → single noop with NOOP_ALREADY_CORRECT reason", () => {
    const actions = decideCodegraphSymlink({
      worktreeRoot: WORKTREE_ROOT,
      targetCodegraphPath: TARGET_CODEGRAPH,
      state: { kind: "present-correct" },
    });
    // Pin the named constant, not the string literal — a future rename of the
    // constant would otherwise pass this test silently.
    expect(actions).toEqual([
      { kind: "noop", from: TARGET_CODEGRAPH, to: EXPECTED_TO, reason: NOOP_ALREADY_CORRECT },
    ]);
  });

  it("present-wrong-target → single repair action; currentTarget not echoed", () => {
    const actions = decideCodegraphSymlink({
      worktreeRoot: WORKTREE_ROOT,
      targetCodegraphPath: TARGET_CODEGRAPH,
      state: { kind: "present-wrong-target", currentTarget: "/some/old/path" },
    });
    expect(actions).toEqual([{ kind: "repair", from: TARGET_CODEGRAPH, to: EXPECTED_TO }]);
    // The applier doesn't need currentTarget (it unlinks the path, not the
    // target); pin its absence so a future widening doesn't slip in.
    expect(actions[0]).not.toHaveProperty("currentTarget");
  });

  it("target-missing → single noop with NOOP_TARGET_MISSING reason", () => {
    const actions = decideCodegraphSymlink({
      worktreeRoot: WORKTREE_ROOT,
      targetCodegraphPath: TARGET_CODEGRAPH,
      state: { kind: "target-missing" },
    });
    expect(actions).toEqual([
      { kind: "noop", from: TARGET_CODEGRAPH, to: EXPECTED_TO, reason: NOOP_TARGET_MISSING },
    ]);
  });
});

describe("applyCodegraphSymlinkActions", () => {
  const FROM = TARGET_CODEGRAPH;
  const TO = EXPECTED_TO;

  it("create action → single symlink call", async () => {
    const t = makeFs([{ op: "symlink", match: (target, p) => target === FROM && p === TO }]);
    const actions: SymlinkAction[] = [{ kind: "create", from: FROM, to: TO }];
    await applyCodegraphSymlinkActions(actions, t.fs);
    expect(t.calls.length).toBe(1);
    expect(t.calls[0]).toEqual(["symlink", FROM, TO]);
  });

  it("repair action → unlink then symlink, in that order (load-bearing)", async () => {
    const t = makeFs([
      { op: "unlink", match: (p) => p === TO },
      { op: "symlink", match: (target, p) => target === FROM && p === TO },
    ]);
    const actions: SymlinkAction[] = [{ kind: "repair", from: FROM, to: TO }];
    await applyCodegraphSymlinkActions(actions, t.fs);
    // Order is load-bearing — symlinking before unlinking would EEXIST on a
    // real fs; the in-memory fake won't catch that, so pin the sequence here.
    expect(t.calls.length).toBe(2);
    expect(t.calls[0]).toEqual(["unlink", TO]);
    expect(t.calls[1]).toEqual(["symlink", FROM, TO]);
  });

  it("noop action → zero fs calls (load-bearing AC pin)", async () => {
    // No routes registered: any call would hit `No route matched: ...` and
    // fail the test.
    const t = makeFs([]);
    const actions: SymlinkAction[] = [
      { kind: "noop", from: FROM, to: TO, reason: NOOP_TARGET_MISSING },
    ];
    await applyCodegraphSymlinkActions(actions, t.fs);
    expect(t.calls.length).toBe(0);
  });

  it("multi-action list applies each in order; noop-skip doesn't short-circuit", async () => {
    const t = makeFs([{ op: "symlink", match: (target, p) => target === FROM && p === TO }]);
    const actions: SymlinkAction[] = [
      { kind: "noop", from: FROM, to: TO, reason: NOOP_ALREADY_CORRECT },
      { kind: "create", from: FROM, to: TO },
    ];
    await applyCodegraphSymlinkActions(actions, t.fs);
    expect(t.calls.length).toBe(1);
    expect(t.calls[0]).toEqual(["symlink", FROM, TO]);
  });

  it("symlink rejection propagates verbatim", async () => {
    const canary = "CANARY: EACCES";
    const t = makeFs([
      {
        op: "symlink",
        match: () => true,
        respond: () => {
          throw new Error(canary);
        },
      },
    ]);
    const actions: SymlinkAction[] = [{ kind: "create", from: FROM, to: TO }];
    let caught: unknown;
    try {
      await applyCodegraphSymlinkActions(actions, t.fs);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(canary);
  });
});
