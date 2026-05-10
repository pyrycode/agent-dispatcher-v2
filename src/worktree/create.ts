// Worktree-creation primitive — `createWorktree(branch, repoRoot, worktreeDir,
// spawn)` — plus a pure parser `findWorktreesForBranch` for walking
// `git worktree list --porcelain` output without the seam. Sibling of
// `cleanup.ts` (#43): one I/O wrapper + one pure parser, free function (no
// state to bind), errors surface verbatim from the underlying `git`
// subprocess.
//
// Load-bearing invariant: errors propagate verbatim. Collision recovery
// (path already registered, branch already checked out elsewhere) is the
// dispatch layer's concern — it composes `removeWorktree` in front of
// `createWorktree` for retry semantics. This module makes zero
// collision-recovery decisions; same posture as cleanup making zero creation
// decisions.
//
// `Subprocess` / `SubprocessResult` are imported from `./cleanup.ts` rather
// than re-declared — second importer per the narrow-types ladder. Promotion
// to a shared module is the third caller's concern.

import { resolve } from "node:path";
import type { Subprocess } from "./cleanup.ts";

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string;
}

export async function createWorktree(
  branch: string,
  repoRoot: string,
  worktreeDir: string,
  spawn: Subprocess,
): Promise<string> {
  // Pre-flight: does the branch already exist? `rev-parse --verify --quiet`
  // returns 0 if yes, 1 if no. Anything else is abnormal — surface verbatim.
  const probe = await spawn([
    "git",
    "-C",
    repoRoot,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (probe.exitCode !== 0 && probe.exitCode !== 1) {
    throw new Error(probe.stderr.trim() || `git rev-parse failed (exit ${probe.exitCode})`);
  }
  const branchExists = probe.exitCode === 0;

  const argv = branchExists
    ? ["git", "-C", repoRoot, "worktree", "add", worktreeDir, branch]
    : ["git", "-C", repoRoot, "worktree", "add", "-b", branch, worktreeDir];
  const add = await spawn(argv);
  if (add.exitCode !== 0) {
    throw new Error(add.stderr.trim() || `git worktree add failed (exit ${add.exitCode})`);
  }

  return resolve(repoRoot, worktreeDir);
}

// Pure parser — walks `git worktree list --porcelain` paragraphs and returns
// every entry whose `branch refs/heads/<name>` line equals `branch`. Blocks
// without a `branch refs/heads/...` line (bare, detached, tag refs) are
// silently skipped. Caller passes the short branch name (`feature/44`); the
// parser strips the `refs/heads/` prefix porcelain prepends — same posture as
// `findCollidingWorktree` (caller passes the path it gave to `git worktree
// add`, parser matches what porcelain echoes).
//
// Multiple matches are possible (`git worktree add --force` makes a branch
// reachable at multiple paths), so the return is an array. Order is encounter
// order in the porcelain input.
export function findWorktreesForBranch(porcelain: string, branch: string): WorktreeInfo[] {
  const HEADS = "refs/heads/";
  const out: WorktreeInfo[] = [];
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    let path: string | null = null;
    let blockBranch: string | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length);
        if (ref.startsWith(HEADS)) blockBranch = ref.slice(HEADS.length);
      }
    }
    if (path !== null && blockBranch !== null && blockBranch === branch) {
      out.push({ path, branch: blockBranch });
    }
  }
  return out;
}
