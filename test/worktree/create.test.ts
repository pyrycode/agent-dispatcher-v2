import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Subprocess, SubprocessResult } from "../../src/worktree/cleanup.ts";
import {
  type WorktreeInfo,
  createWorktree,
  findWorktreesForBranch,
} from "../../src/worktree/create.ts";

// Routing-table recording mock — copied verbatim from cleanup.test.ts. Second
// user; third worktree test file should drive the extraction to a shared util
// (per architect's spec § Testing strategy).
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

const argvEq = (expected: readonly string[]) => (argv: readonly string[]) =>
  argv.length === expected.length && argv.every((a, i) => a === expected[i]);

const REPO = "/tmp/repo";
const WORKTREE = "/tmp/wt-44";
const BRANCH = "feature/44";

describe("createWorktree", () => {
  it("happy path — new branch, pre-flight reports absent, `-b` form runs", async () => {
    const t = makeSpawn([
      {
        match: argvEq([
          "git",
          "-C",
          REPO,
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${BRANCH}`,
        ]),
        respond: () => fail(""),
      },
      {
        match: argvEq(["git", "-C", REPO, "worktree", "add", "-b", BRANCH, WORKTREE]),
        respond: () => ok(),
      },
    ]);
    const path = await createWorktree(BRANCH, REPO, WORKTREE, t.fn);
    expect(path).toBe(resolve(REPO, WORKTREE));
    expect(t.calls.length).toBe(2);
    expect(t.calls[1]).toEqual(["git", "-C", REPO, "worktree", "add", "-b", BRANCH, WORKTREE]);
  });

  it("branch already exists — pre-flight reports present, bare form runs (no `-b`)", async () => {
    const t = makeSpawn([
      {
        match: argvEq([
          "git",
          "-C",
          REPO,
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${BRANCH}`,
        ]),
        respond: () => ok(),
      },
      {
        match: argvEq(["git", "-C", REPO, "worktree", "add", WORKTREE, BRANCH]),
        respond: () => ok(),
      },
    ]);
    const path = await createWorktree(BRANCH, REPO, WORKTREE, t.fn);
    expect(path).toBe(resolve(REPO, WORKTREE));
    expect(t.calls.length).toBe(2);
    // Bare-vs-`-b` discrimination is load-bearing — a future "always use `-B`"
    // simplification breaks this assertion.
    expect(t.calls[1]).toEqual(["git", "-C", REPO, "worktree", "add", WORKTREE, BRANCH]);
  });

  it("subprocess error surfaces verbatim — `worktree add` fails on collision", async () => {
    const canary = "fatal: '/tmp/wt-44' already exists";
    const t = makeSpawn([
      {
        match: argvEq([
          "git",
          "-C",
          REPO,
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${BRANCH}`,
        ]),
        respond: () => ok(),
      },
      {
        match: argvEq(["git", "-C", REPO, "worktree", "add", WORKTREE, BRANCH]),
        respond: () => fail(canary),
      },
    ]);
    let caught: unknown;
    try {
      await createWorktree(BRANCH, REPO, WORKTREE, t.fn);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("already exists");
  });
});

describe("findWorktreesForBranch", () => {
  function block(path: string, branchRef: string | null): string {
    const lines = [`worktree ${path}`, "HEAD 0000000000000000000000000000000000000000"];
    if (branchRef === null) lines.push("detached");
    else lines.push(`branch ${branchRef}`);
    return `${lines.join("\n")}\n`;
  }

  it("single match — returns one entry", () => {
    const target = "/Users/foo/.pyrycode-worktrees/architect-44";
    const porcelain =
      `${block("/Users/foo/repo", "refs/heads/main")}\n` +
      `${block(target, "refs/heads/feature/44")}`;
    const got: WorktreeInfo[] = findWorktreesForBranch(porcelain, "feature/44");
    expect(got).toEqual([{ path: target, branch: "feature/44" }]);
  });

  it("multiple matches — returns all entries in input order", () => {
    const a = "/Users/foo/.pyrycode-worktrees/architect-44";
    const b = "/Users/foo/.pyrycode-worktrees/developer-44";
    const porcelain =
      `${block(a, "refs/heads/feature/44")}\n` +
      `${block("/Users/foo/repo", "refs/heads/main")}\n` +
      `${block(b, "refs/heads/feature/44")}`;
    const got = findWorktreesForBranch(porcelain, "feature/44");
    expect(got).toEqual([
      { path: a, branch: "feature/44" },
      { path: b, branch: "feature/44" },
    ]);
  });

  it("no matches — returns empty array", () => {
    const porcelain =
      `${block("/Users/foo/repo", "refs/heads/main")}\n` +
      `${block("/Users/foo/.pyrycode-worktrees/other-77", "refs/heads/feature/77")}`;
    expect(findWorktreesForBranch(porcelain, "feature/44")).toEqual([]);
  });

  it("malformed / non-branch blocks silently skipped", () => {
    const target = "/Users/foo/.pyrycode-worktrees/architect-44";
    // - matching block on feature/44
    // - detached HEAD (no `branch` line) — must be skipped, not throw
    // - tag ref — parser only strips `refs/heads/`; this matches nothing
    // - stray garbage line inside an otherwise-valid (non-matching) block
    const porcelain = [
      block(target, "refs/heads/feature/44"),
      block("/Users/foo/.pyrycode-worktrees/detached", null),
      block("/Users/foo/.pyrycode-worktrees/tagged", "refs/tags/v1"),
      "worktree /Users/foo/.pyrycode-worktrees/garbage\nHEAD 0\ngarbage line\nbranch refs/heads/main\n",
    ].join("\n");
    expect(findWorktreesForBranch(porcelain, "feature/44")).toEqual([
      { path: target, branch: "feature/44" },
    ]);
  });
});
