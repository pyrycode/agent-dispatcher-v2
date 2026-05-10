// Pure predicates for blocker classification and empty-branch routing.
//
// The two named predicates here (hasOpenBlockers, shouldFlagEmptyBranch) are
// the deterministic backstops to stochastic agent prose ("check for blockers",
// "remember to commit"). See CLAUDE.md § "Belt-and-suspenders". This file is
// pure — no await, no gh / git / fs calls. Callers in src/dispatch/ and
// src/loop/ supply the inputs.

export interface Blocker {
  // Caller (src/github/) maps GitHub's issue state to this string. Only "OPEN"
  // counts as a live blocker; anything else is treated as not-blocking, so
  // unknown future state values fail safe rather than deadlocking dispatch.
  state: string;
}

export interface BranchState {
  commitsAhead: number;
  labels: readonly string[];
}

export type AgentName = "architect" | "developer" | "code-review" | "documentation";
export type AgentAction = "run";

export function hasOpenBlockers(blockers: readonly Blocker[]): boolean {
  return blockers.some((b) => b.state === "OPEN");
}

// Parses `git rev-list --count` output. Throws on malformed input so callers
// cannot silently propagate garbage into the empty-branch check.
export function parseCommitsAhead(gitRevListOutput: string): number {
  const trimmed = gitRevListOutput.trim();
  if (trimmed.length === 0) {
    throw new Error("parseCommitsAhead: empty output");
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`parseCommitsAhead: not a non-negative integer: ${gitRevListOutput}`);
  }
  return Number(trimmed);
}

export function shouldFlagEmptyBranch(state: BranchState): boolean {
  if (state.commitsAhead > 0) return false;
  if (hasNeedsReworkLabel(state.labels)) return false;
  return true;
}

export function shouldProduceCommits(agent: AgentName, action: AgentAction): boolean {
  // Every agent run that holds a worktree is currently expected to produce
  // commits on success. The deliberate-bail case is captured by the
  // needs-rework:* label, not by the (agent, action) shape — see
  // shouldFlagEmptyBranch above.
  if (action !== "run") return false;
  switch (agent) {
    case "architect":
    case "developer":
    case "code-review":
    case "documentation":
      return true;
  }
}

function hasNeedsReworkLabel(labels: readonly string[]): boolean {
  return labels.some((l) => l.startsWith("needs-rework:"));
}
