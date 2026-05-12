// Happy-path callee invoked by the dispatcher after `classifyAgentResult`
// returns "ok". Arms the next forward auto-advance by adding
// `ready:<state.agent>` on the issue; the column does NOT change here, so
// no project-board Status mutation is issued. Errors from `addLabel`
// propagate — the orchestrator's outer try/catch routes them through
// handleDispatchError, which tags `error:dispatch`. Swallowing here would
// silently drop the architect-success and the ticket would re-dispatch as
// if the agent had never run.
//
// Carve-out: the post-run `ready:<agent>` add does not fire a transition,
// it merely arms one for the next dispatcher cycle, so no row of
// TRANSITIONS describes it and the add bypasses decideLabelDelta. This is
// the same precedent as the `wip:*` / `error:*` carve-outs documented at
// src/pipeline/transitions.ts:37-41 (and exercised by
// src/dispatch/handleDispatchError.ts and src/salvage/draft-pr.ts), with
// one subtle adaptation: `ready:*` IS a member of the Label union — the
// carve-out here is "this label-add isn't a transition-firing event", not
// "this label isn't a transition label". The forward row that later
// CONSUMES the same `ready:<agent>` (e.g. transitions.ts:80) still
// funnels through decideLabelDelta when decideAutoAdvance fires, so the
// "transition-trigger label mutations funnel through decideLabelDelta"
// invariant holds for the column-changing mutation.
//
// No status mutation: project-board Status mirrors the column. Column
// unchanged ⇒ Status unchanged ⇒ no GitHubProjectClient dep needed.

import type { GitHubLabelsClient } from "../github/labels.ts";
import type { Label } from "../pipeline/transitions.ts";
import type { DispatchState } from "./state.ts";

export interface HandlePostRunDeps {
  readonly labels: Pick<GitHubLabelsClient, "addLabel">;
}

export async function handlePostRun(state: DispatchState, deps: HandlePostRunDeps): Promise<void> {
  // `satisfies Label` is a compile-time guarantee: adding a new Agent
  // member without adding its `ready:*` to the Label union becomes a
  // type error here.
  const readyLabel = `ready:${state.agent}` satisfies Label;
  await deps.labels.addLabel(state.issueNumber, readyLabel);
}
