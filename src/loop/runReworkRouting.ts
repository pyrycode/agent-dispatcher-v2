// Per-cycle maintenance routine: route needs-rework:<agent> tickets back
// to the target agent's column and strip stale ready:* / wip:* / error:*
// labels so the target runs on a clean slate. The triggering
// needs-rework:* label is left in place — the target agent's run consumes
// it.
//
// Belt-and-suspenders: the agent that added the needs-rework:* label is
// the stochastic part; this runner is the deterministic safety net that
// makes the routing actually happen. Per CLAUDE.md "decideLabelDelta is
// the only place labels mutate" the strip set is computed by the pure
// decideReworkRouting in src/pipeline/routing.ts; this file does NOT
// branch on label names.
//
// Idempotency is structural in two ways:
//   1. No needs-rework:* on the item → decideReworkRouting returns
//      target=null; the runner continues to the next item without
//      calling any mutator.
//   2. needs-rework:* present but already in the right column with no
//      stale labels → stripLabels is empty and the target-column check
//      below skips setItemStatus. Zero mutations.
// Below those gates, removeLabel itself is GET-then-PUT-only-if-present
// (src/github/labels.ts) — a third layer that costs at most a single GET
// per accidentally-repeated strip.

import { decideReworkRouting, targetColumnForAgent } from "../pipeline/routing.ts";

// Narrow ports — only the methods this runner actually calls. NOT
// GitHubProjectClient / GitHubLabelsClient as a whole. itemId is the
// GraphQL project-item id (keys setItemStatus); issueNumber keys
// removeLabel.
export interface ReworkRoutingItem {
  readonly itemId: string;
  readonly issueNumber: number;
  readonly status: string;
  readonly labels: readonly string[];
}

export interface ReworkRoutingDeps {
  readonly listItems: () => Promise<readonly ReworkRoutingItem[]>;
  readonly removeLabel: (number: number, name: string) => Promise<void>;
  readonly setItemStatus: (itemId: string, statusName: string) => Promise<void>;
}

export async function runReworkRouting(deps: ReworkRoutingDeps): Promise<void> {
  const items = await deps.listItems();
  for (const item of items) {
    const { target, stripLabels } = decideReworkRouting(item.labels);
    if (target === null) continue;

    for (const name of stripLabels) {
      await deps.removeLabel(item.issueNumber, name);
    }

    const targetColumn = targetColumnForAgent(target);
    if (item.status !== targetColumn) {
      await deps.setItemStatus(item.itemId, targetColumn);
    }
  }
}
