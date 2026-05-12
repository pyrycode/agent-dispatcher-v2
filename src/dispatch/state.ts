// Shared dispatch-state contract. Each per-ticket phase under src/dispatch/
// reads and (when needed) extends this type. Kept deliberately minimal —
// fields are added only when a phase actually reads them. Reuses the
// canonical Agent union from src/pipeline/selection.ts rather than
// redeclaring it.

import type { Agent } from "../pipeline/selection.ts";

export interface DispatchState {
  readonly agent: Agent;
  readonly issueNumber: number;
}
