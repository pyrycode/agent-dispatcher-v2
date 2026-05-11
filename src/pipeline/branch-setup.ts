// Pure predicates for branch-setup choice and the auto-commit safety net.
//
// `decideBranchSetup` picks the worktree's branch name (fresh feature/<n> vs
// reuse of an existing PR's head ref). `shouldAutoCommit` is the deterministic
// backstop for the architect's "commit your spec" prose — see CLAUDE.md
// § "Belt-and-suspenders". Pure: no await, no gh / git / fs. Callers in
// src/dispatch/ and src/loop/ supply the inputs.

export interface BranchSetupState {
  issueNumber: number;
  // Included for shape-symmetry with AutoCommitState so callers can forward
  // one canonical ticket-state object to both predicates. decideBranchSetup
  // does NOT read it — PR-existence is the deterministic disambiguator, not
  // the label (see tests covering both with-label and without-label rows).
  labels: readonly string[];
  // PR head ref of the existing PR for this issue, or null if no PR exists.
  // Caller (src/github/) maps GitHub's PR query result to either the ref
  // string (e.g. "feature/42") or null before handing off.
  existingPrHeadRef: string | null;
}

export type BranchSetupDecision =
  | { readonly kind: "create"; readonly branch: string }
  | { readonly kind: "reuse"; readonly branch: string };

export interface AutoCommitState {
  commitsAhead: number;
  stagedChangesPresent: boolean;
  labels: readonly string[];
}

export function decideBranchSetup(state: BranchSetupState): BranchSetupDecision {
  if (state.existingPrHeadRef !== null) {
    return { kind: "reuse", branch: state.existingPrHeadRef };
  }
  return { kind: "create", branch: `feature/${state.issueNumber}` };
}

export function shouldAutoCommit(state: AutoCommitState): boolean {
  if (state.commitsAhead > 0) return false;
  if (!state.stagedChangesPresent) return false;
  if (hasNeedsReworkLabel(state.labels)) return false;
  return true;
}

function hasNeedsReworkLabel(labels: readonly string[]): boolean {
  return labels.some((l) => l.startsWith("needs-rework:"));
}
