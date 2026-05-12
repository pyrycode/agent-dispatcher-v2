// Per-dispatch cleanup. Removes the transient `wip:<agent>` label that
// pre-dispatch armed to prevent double-dispatch. Runs on the exit path
// of every dispatched ticket — happy OR error — so the next loop
// iteration sees a clean slate.
//
// Carve-out: `wip:*` is dispatcher run-state, not a transition trigger.
// Per the comment block at src/pipeline/transitions.ts:38-41 the Label
// union explicitly excludes `wip:*`, so this phase legitimately calls
// removeLabel directly via injected deps rather than funnelling through
// decideLabelDelta. Same precedent as src/dispatch/handleDispatchError.ts
// (`error:*`) and src/salvage/draft-pr.ts (`error:max_turns_salvaged`).
//
// Idempotency: removeLabel at src/github/labels.ts:54 is GET-then-PUT-
// only-if-present — invoking against a ticket whose `wip:<agent>` label
// is already absent is a silent no-op (no throw, no PUT). This wrapper
// inherits that contract without adding an extra existence check; doing
// so here would duplicate the underlying I/O.
//
// Errors from removeLabel (transport failure, HTTP 5xx, network drop)
// propagate to the caller. The orchestrator's outer wrap owns logging
// cleanup failures; swallowing here would hide them.

import type { GitHubLabelsClient } from "../github/labels.ts";
import type { DispatchState } from "./state.ts";

export interface CleanupAfterDispatchDeps {
  readonly labels: Pick<GitHubLabelsClient, "removeLabel">;
}

export async function cleanupAfterDispatch(
  state: DispatchState,
  deps: CleanupAfterDispatchDeps,
): Promise<void> {
  const wipLabel = `wip:${state.agent}`;
  await deps.labels.removeLabel(state.issueNumber, wipLabel);
}
