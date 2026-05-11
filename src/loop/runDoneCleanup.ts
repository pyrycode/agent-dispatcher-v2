// Per-cycle maintenance routine: strip stale pipeline labels from Done items.
//
// Belt-and-suspenders for the In Documentation → Done strip rule. The
// auto-advance path that drives that transition already strips ready:* /
// needs-rework:* on entry, but tickets can land in Done by other paths
// (human manual move from a non-canonical column, post-Done human label
// edit, etc.). This runner re-asserts the entry-transition strip rule each
// cycle so the board state matches the pipeline's rules. Per CLAUDE.md
// "decideLabelDelta is the only place labels mutate" the strip set is read
// from the transition table; this file does NOT branch on label names.
//
// Idempotency falls out of two layers stacked together:
//   1. decideLabelDelta returns { remove: [] } when no current label
//      matches the strip-prefix patterns from the transition row.
//   2. removeLabel is GET-then-PUT-only-if-present (src/github/labels.ts) —
//      removing an absent label issues only the GET, no PUT, no throw.
// Either layer alone is sufficient; together they cap the cost of a
// repeat invocation at zero GitHub mutations.

import { decideLabelDelta } from "../pipeline/decisions.ts";
import type { Label } from "../pipeline/transitions.ts";

// Narrow ports — only the methods this runner actually calls. NOT
// GitHubProjectClient / GitHubLabelsClient as a whole.
export interface DoneCleanupItem {
  readonly issueNumber: number;
  readonly status: string;
  readonly labels: readonly string[];
}

export interface DoneCleanupDeps {
  readonly listItems: () => Promise<readonly DoneCleanupItem[]>;
  readonly removeLabel: (number: number, name: string) => Promise<void>;
}

export async function runDoneCleanup(deps: DoneCleanupDeps): Promise<void> {
  const items = await deps.listItems();
  for (const item of items) {
    if (item.status !== "Done") continue;
    // The "before" column is fictitious — the actual current column is
    // "Done" — but the semantics is "if this ticket were to enter Done
    // now, what would get stripped?". The transition table owns the
    // strip-prefix list; this caller does not. Empty after.labels
    // maximises the strip filter.
    const delta = decideLabelDelta(
      { column: "In Documentation", labels: item.labels as readonly Label[] },
      { column: "Done", labels: [] },
    );
    for (const name of delta.remove) {
      await deps.removeLabel(item.issueNumber, name);
    }
  }
}
