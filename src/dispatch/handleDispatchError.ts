// Catch-path callee for the dispatcher's per-ticket try/catch. Tags the
// issue with `error:dispatch` so a failed run is observable in the GitHub
// UI, logs the original error via an injected logger, and NEVER rethrows —
// a successful return tells the orchestrator "logged, move on; the loop
// continues with the next ticket".
//
// Carve-out: `error:*` labels are dispatcher run-state metadata, not
// transition triggers. Per the comment block at src/pipeline/transitions.ts:38-41
// the Label union explicitly excludes them, so this phase legitimately
// calls addLabel directly via injected deps rather than funnelling through
// decideLabelDelta. The same carve-out lets src/salvage/draft-pr.ts apply
// `error:max_turns_salvaged` without consulting the transition table.
//
// Pairing note: src/pipeline/routing.ts:29 lists "error:" in STRIP_PREFIXES,
// so the label naturally clears the next time rework routing fires. No
// explicit cleanup is needed here.

import type { GitHubLabelsClient } from "../github/labels.ts";
import type { DispatchState } from "./state.ts";

export const DISPATCH_ERROR_LABEL = "error:dispatch";

export interface DispatchErrorLogger {
  error(
    err: unknown,
    context: {
      readonly issueNumber: number;
      readonly agent: string;
      readonly phase: "dispatch";
    },
  ): void;
}

export interface HandleDispatchErrorDeps {
  readonly labels: Pick<GitHubLabelsClient, "addLabel">;
  readonly logger: DispatchErrorLogger;
}

export async function handleDispatchError(
  error: unknown,
  state: DispatchState,
  deps: HandleDispatchErrorDeps,
): Promise<void> {
  // Log the original error first — it's the load-bearing observability,
  // and must be captured whether or not GitHub is reachable below.
  deps.logger.error(error, {
    issueNumber: state.issueNumber,
    agent: state.agent,
    phase: "dispatch",
  });

  // try/catch (not .catch) to mirror salvage's inverse contract:
  // salvage rethrows on addLabel failure; this catch-path swallows-and-logs.
  try {
    await deps.labels.addLabel(state.issueNumber, DISPATCH_ERROR_LABEL);
  } catch (labelErr) {
    deps.logger.error(labelErr, {
      issueNumber: state.issueNumber,
      agent: state.agent,
      phase: "dispatch",
    });
  }
}
