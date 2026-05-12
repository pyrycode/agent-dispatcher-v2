// Pre-spawn phase 1: pick the feature branch (fresh feature/<n> vs reuse
// of an existing PR's head ref) and materialize the worktree. Pure-predicate
// decision delegated to decideBranchSetup; I/O taken from injected deps so
// unit tests DI fakes. No gh or git invocation lives in this file.
//
// The dep `lookupExistingPrHeadRef` is a NEW seam — src/github/pr.ts does
// not yet expose a by-issue PR-head-ref lookup. Wiring the production
// implementation is a follow-up ticket; this module defines only the shape.
//
// The dep `createWorktree` is the launcher-bound surface of the primitive
// at src/worktree/create.ts. The launcher binds (repoRoot, worktreeDir,
// spawn) once; this orchestrator only passes the branch and consumes the
// returned path.

import { decideBranchSetup } from "../pipeline/branch-setup.ts";
import type { DispatchState } from "./state.ts";

export interface SetupBranchAndWorktreeDeps {
  readonly lookupExistingPrHeadRef: (issueNumber: number) => Promise<string | null>;
  readonly createWorktree: (branch: string) => Promise<string>;
}

export interface SetupBranchAndWorktreeResult {
  readonly branch: string;
  readonly worktreePath: string;
  readonly kind: "create" | "reuse";
}

export async function setupBranchAndWorktree(
  state: DispatchState,
  deps: SetupBranchAndWorktreeDeps,
): Promise<SetupBranchAndWorktreeResult> {
  const existingPrHeadRef = await deps.lookupExistingPrHeadRef(state.issueNumber);
  const decision = decideBranchSetup({
    issueNumber: state.issueNumber,
    // decideBranchSetup does not read `labels` — see comment at
    // src/pipeline/branch-setup.ts:11-14. Passed empty to satisfy the
    // predicate's type without inflating DispatchState.
    labels: [],
    existingPrHeadRef,
  });
  const worktreePath = await deps.createWorktree(decision.branch);
  return { branch: decision.branch, worktreePath, kind: decision.kind };
}
