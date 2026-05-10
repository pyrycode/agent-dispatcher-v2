// Idempotent worktree-removal primitive — `removeWorktree(path, spawn)` —
// with built-in collision auto-recovery (locate the orphaned entry in
// `git worktree list --porcelain`, force-remove it, retry the original
// removal once). Called by post-run cleanup and the create-time
// collision-retry path.
//
// Load-bearing invariant: removing a path that's already gone is a noop,
// not an error. Done-cleanup runs from many sites; a strict "throw if
// absent" semantic would force every caller into a try/catch — same shape
// rule as removeLabel (#36).
//
// What this does NOT decide: which worktree to remove (caller's job),
// when to retry the create after a successful cleanup (separate ticket),
// pruning stale `git worktree list` entries whose dirs were deleted
// out-of-band (`git worktree prune`'s job).
//
// Per CLAUDE.md "Belt-and-suspenders": this idempotency + recovery is the
// deterministic safety net behind the agent's "remember to clean up"
// prose — same family as the empty-branch-guard / auto-commit nets.

import { access } from "node:fs/promises";

export interface SubprocessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// DI seam — callable that runs argv as a subprocess and resolves with
// exit/stdout/stderr. MUST NOT throw on non-zero exit; the function below
// classifies exit codes, and a thrown rejection would bypass the recovery
// branches. Production wiring (separate ticket) wraps `child_process.spawn`.
export type Subprocess = (argv: readonly string[]) => Promise<SubprocessResult>;

export async function removeWorktree(path: string, spawn: Subprocess): Promise<void> {
  // Filesystem fast path — zero spawn calls when path is absent. The AC
  // pins this exactly. False-positive on stale-registered (path missing on
  // disk but still in `git worktree list`) is `git worktree prune`'s
  // concern, not ours.
  if (!(await pathExists(path))) return;

  const r1 = await spawn(["git", "worktree", "remove", path]);
  if (r1.exitCode === 0) return;

  // Recovery — locate the conflicting entry, force-remove it, retry once.
  const list = await spawn(["git", "worktree", "list", "--porcelain"]);
  if (list.exitCode !== 0) {
    throw new Error(`git worktree list failed: ${list.stderr.trim()}`);
  }

  const conflict = findCollidingWorktree(list.stdout, path);
  if (conflict === null) {
    // Path exists on disk but isn't a registered worktree — nothing more
    // we can do here. Treat as noop after the diagnostic list call.
    return;
  }

  const force = await spawn(["git", "worktree", "remove", "--force", conflict]);
  if (force.exitCode !== 0) {
    throw new Error(`git worktree remove --force failed: ${force.stderr.trim()}`);
  }

  // If the force already removed our target, retry would be a noop.
  if (conflict === path) return;

  const r2 = await spawn(["git", "worktree", "remove", path]);
  if (r2.exitCode !== 0) {
    throw new Error(r2.stderr.trim() || `git worktree remove ${path} failed`);
  }
}

// Pure parser — exported for unit testing without the seam. Splits porcelain
// output into blank-line-separated paragraphs and walks each block's lines
// looking for `worktree <p>`; returns `targetPath` when an entry's path
// equals it exactly, else null. Exact equality, no path normalisation per
// #6 set-intersection-style-predicates — `git worktree list` echoes the
// path the caller gave to `git worktree add`. NO fallback to "first entry":
// the first porcelain block is conventionally the repository's main
// worktree, and a fallback would let `removeWorktree` force-remove the
// main repo on a parser miss. Locate-by-branch (the AC's "or registered
// branch" half) is a future extension the create-collision callsite will
// drive once it has a branch name to pass.
export function findCollidingWorktree(porcelain: string, targetPath: string): string | null {
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) continue;
      if (line.slice("worktree ".length) === targetPath) return targetPath;
    }
  }
  return null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
