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

  it("retry-still-fails surfaces stderr verbatim", async () => {
    // Orphan path P' is fictitious — the subprocess seam is mocked, so it
    // doesn't need to exist on disk. The target `tmp` exists (real dir),
    // its remove fails, the parser locates P', force on P' succeeds, then
    // the retry of the original remove on `tmp` fails — the AC branch.
    const orphan = "/nonexistent/orphan-worktree-path";
    const canary = "CANARY: still locked\n";
    const t = makeSpawn([
      {
        match: argvEq(["git", "worktree", "remove", tmp]),
        respond: () => {
          // First call (bare) fails; second call (retry) also fails with
          // the canary stderr the test pins on.
          if (t.calls.filter((c) => argvEq(["git", "worktree", "remove", tmp])(c)).length === 1) {
            return fail("fatal: locked");
          }
          return fail(canary);
        },
      },
      {
        match: argvEq(["git", "worktree", "list", "--porcelain"]),
        respond: () => ok(porcelainBlock(orphan)),
      },
      {
        match: argvEq(["git", "worktree", "remove", "--force", orphan]),
        respond: () => ok(),
      },
    ]);
    let caught: unknown;
    try {
      await removeWorktree(tmp, t.fn);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // `.trim()` strips the trailing newline per design — "verbatim" in the
    // AC means the operator sees the original git error string, not noise.
    expect((caught as Error).message).toContain("CANARY: still locked");
    // Calls: r1 (fail), list, force on orphan, r2 (fail) — four total.
    expect(t.calls.length).toBe(4);
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

  it("no exact match — falls back to the first worktree entry as orphan candidate", () => {
    // The create-time collision shape: the registered path differs from
    // the target (e.g. inherited from a dead earlier dispatch). Returning
    // the first entry lets the recovery force-remove it.
    const orphan = "/Users/foo/.pyrycode-worktrees/architect-43";
    const porcelain = porcelainBlock(orphan, "refs/heads/feature/43");
    expect(findCollidingWorktree(porcelain, "/some/other/path")).toBe(orphan);
  });
});
