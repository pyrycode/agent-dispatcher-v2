// Per-cycle maintenance routine: attempt to merge the ready PR attached to
// each Done-column item. On merge conflict, roll the ticket's project
// Status from Done back to In Code Review so a human reviewer sees it
// rather than the dispatcher silently re-dispatching closed work into
// stages it has already passed (v1 #218 lesson).
//
// Idempotency falls out of two predicate gates stacked:
//   1. `item.status !== "Done"` skips anything outside the Done column.
//   2. `findReadyPrNumber(prs) === null` skips Done items whose PR is
//      already merged (closed PRs aren't in the candidate list) or whose
//      candidates are all drafts / error-labeled.
//
// Rollback variant gate: ONLY `MergeResult.reason === "conflict"` triggers
// the Status rollback. `reason === "other"` is treated as transient — the
// PR stays open, the ticket stays in Done, and the next cycle retries.

import type { MergeResult } from "../github/pr.ts";
import { type ReadyPrCandidate, findReadyPrNumber } from "../pipeline/find-ready-pr.ts";

// Narrow ports — only the data + mutations this runner actually consumes.
// `setItemStatusToInCodeReview` is intentionally narrower than the
// underlying `setItemStatus(itemId, statusName)` so the runner contract
// carries no magic string and the test fake records one thing per call.
export interface AutoMergeItem {
  readonly id: string;
  readonly issueNumber: number;
  readonly status: string;
}

export interface AutoMergeDeps {
  readonly listItems: () => Promise<readonly AutoMergeItem[]>;
  readonly listPrsForItem: (item: AutoMergeItem) => Promise<readonly ReadyPrCandidate[]>;
  readonly mergePr: (prNumber: number) => Promise<MergeResult>;
  readonly setItemStatusToInCodeReview: (itemId: string) => Promise<void>;
}

export async function runAutoMerge(deps: AutoMergeDeps): Promise<void> {
  const items = await deps.listItems();
  for (const item of items) {
    if (item.status !== "Done") continue;
    const prs = await deps.listPrsForItem(item);
    const readyPr = findReadyPrNumber(prs);
    if (readyPr === null) continue;
    const result = await deps.mergePr(readyPr);
    if (!result.merged && result.reason === "conflict") {
      await deps.setItemStatusToInCodeReview(item.id);
    }
  }
}
