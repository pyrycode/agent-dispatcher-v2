import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Subprocess,
  type SubprocessResult,
  findCollidingWorktree,
  removeWorktree,
} from "../../src/worktree/cleanup.ts";

// Routing-table recording mock — argv-shaped sibling of `makeTransport` from
// test/github/labels.test.ts. The `calls` log is the verification mechanism
// for the AC's "zero subprocess calls in the noop branch" pin.
type Route = {
  match: (argv: readonly string[]) => boolean;
  respond: (argv: readonly string[]) => SubprocessResult | Promise<SubprocessResult>;
};

interface RecordingSpawn {
  fn: Subprocess;
  calls: string[][];
}

function makeSpawn(routes: readonly Route[]): RecordingSpawn {
  const calls: string[][] = [];
  const fn: Subprocess = async (argv) => {
    calls.push([...argv]);
    for (const r of routes) if (r.match(argv)) return r.respond(argv);
    throw new Error(`No route matched: ${argv.join(" ")}`);
  };
  return { fn, calls };
}

const ok = (stdout = ""): SubprocessResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): SubprocessResult => ({ exitCode: 1, stdout: "", stderr });

// `git worktree list --porcelain` block fixture for one registered entry.
function porcelainBlock(path: string, branch = "refs/heads/feature/43"): string {
  return `worktree ${path}\nHEAD 0000000000000000000000000000000000000000\nbranch ${branch}\n`;
}

const argvEq = (expected: readonly string[]) => (argv: readonly string[]) =>
  argv.length === expected.length && argv.every((a, i) => a === expected[i]);

describe("removeWorktree", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cleanup-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("happy path — single successful `git worktree remove`", async () => {
    const t = makeSpawn([
      { match: argvEq(["git", "worktree", "remove", tmp]), respond: () => ok() },
    ]);
    await removeWorktree(tmp, t.fn);
    expect(t.calls.length).toBe(1);
    expect(t.calls[0]).toEqual(["git", "worktree", "remove", tmp]);
  });

  it("already-absent — zero subprocess calls (load-bearing AC pin)", async () => {
    // Path that genuinely doesn't exist on disk. No routes registered: any
    // spawn call would hit `No route matched: ...` and fail the test.
    const ghost = join(tmpdir(), `nonexistent-${randomBytes(8).toString("hex")}`);
    const t = makeSpawn([]);
    await removeWorktree(ghost, t.fn);
    // The AC's "zero subprocess calls in the noop branch is asserted" is
    // satisfied by this exact pin. A future "always shell out for symmetry"
    // simplification would still satisfy "no throw" but fails this count.
    expect(t.calls.length).toBe(0);
  });

  it("collision on remove triggers locate → force-remove → retry-skip when conflict===path", async () => {
    const t = makeSpawn([
      {
        match: argvEq(["git", "worktree", "remove", tmp]),
        respond: () => fail("fatal: ... locked working tree ..."),
      },
      {
        match: argvEq(["git", "worktree", "list", "--porcelain"]),
        respond: () => ok(porcelainBlock(tmp)),
      },
      {
        match: argvEq(["git", "worktree", "remove", "--force", tmp]),
        respond: () => ok(),
      },
    ]);
    await removeWorktree(tmp, t.fn);
    // Three calls — NOT four — because the parser's `conflict === path`
    // short-circuit skips the redundant retry of the original removal.
    expect(t.calls.length).toBe(3);
    expect(t.calls[2]).toEqual(["git", "worktree", "remove", "--force", tmp]);
  });

  it("collision then `git worktree list` fails — surfaces stderr verbatim", async () => {
    // The AC's "retry-still-fails surfaces error verbatim" branch is
    // unreachable today: with exact-match-or-null on findCollidingWorktree,
    // a non-null conflict always equals the target path, so the
    // `conflict === path` short-circuit fires and the retry never runs.
    // That branch only becomes reachable once the locate-by-branch half of
    // the AC lands at the create-collision callsite (separate ticket).
    // Until then, this test exercises a reachable error branch with the
    // same verbatim-stderr posture: list-after-collision failing.
    const canary = "CANARY: list refused";
    const t = makeSpawn([
      {
        match: argvEq(["git", "worktree", "remove", tmp]),
        respond: () => fail("fatal: locked working tree"),
      },
      {
        match: argvEq(["git", "worktree", "list", "--porcelain"]),
        respond: () => fail(canary),
      },
    ]);
    let caught: unknown;
    try {
      await removeWorktree(tmp, t.fn);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(canary);
    expect(t.calls.length).toBe(2);
  });
});

describe("findCollidingWorktree", () => {
  it("multi-block porcelain — finds the entry whose worktree line equals targetPath", () => {
    const target = "/Users/foo/.pyrycode-worktrees/architect-43";
    const porcelain =
      `${porcelainBlock("/Users/foo/repo", "refs/heads/main")}\n` +
      `${porcelainBlock(target, "refs/heads/feature/43")}`;
    expect(findCollidingWorktree(porcelain, target)).toBe(target);
  });

  it("empty porcelain — returns null (no worktree entries to recover)", () => {
    expect(findCollidingWorktree("", "/some/path")).toBeNull();
  });

  it("no exact match — returns null (no first-entry fallback; first block is the main repo)", () => {
    // First-block fallback would let removeWorktree force-remove the main
    // repository worktree on a parser miss. Exact-match-or-null is the
    // safe contract; locate-by-branch is a future extension.
    const porcelain =
      `${porcelainBlock("/Users/foo/repo", "refs/heads/main")}\n` +
      `${porcelainBlock("/Users/foo/.pyrycode-worktrees/other-77", "refs/heads/feature/77")}`;
    expect(findCollidingWorktree(porcelain, "/some/other/path")).toBeNull();
  });
});
