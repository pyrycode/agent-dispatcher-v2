// Shared dispatch-state contract. Each per-ticket phase under src/dispatch/
// reads and (when needed) extends this type. Kept deliberately minimal —
// fields are added only when a phase actually reads them. Reuses the
// canonical Agent union from src/pipeline/selection.ts rather than
// redeclaring it.

import type { Agent } from "../pipeline/selection.ts";

export interface DispatchState {
  readonly agent: Agent;
  readonly issueNumber: number;
  // Resolved path to the per-dispatch worktree. Populated by the prior
  // pre-spawn phase (setupBranchAndWorktree) and consumed by
  // prepareAgentSpawn as the descriptor's `cwd`.
  readonly worktreePath: string;
  // Caller-supplied tail args for `claude` (post-prompt-assembly).
  // spawnClaude prepends `-p --output-format stream-json` itself, so this
  // array does NOT include those flags.
  readonly args: readonly string[];
}
