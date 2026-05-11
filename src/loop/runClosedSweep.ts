// Per-cycle maintenance routine: move CLOSED issues sitting in pre-Done
// columns into Done so the dispatcher's selection pass doesn't re-dispatch
// them. Backstops the v1 lesson "Closed GitHub issue ≠ removed from
// project board" with a deterministic each-cycle reconciliation.
//
// Idempotency: the predicate skips items whose Status is already "Done",
// so a repeat invocation issues zero mutations. Per CLAUDE.md "The 'closed
// but not in Done' predicate is small; if it grows non-trivial extract a
// pure function" — it doesn't grow here. Inline stays.

// Narrow ports — only the data + mutation this runner actually consumes.
// `setItemStatusToDone` is intentionally narrower than the underlying
// `setItemStatus(itemId, statusName)` so the runner contract carries no
// magic string and the test fake records one thing per call.
export interface ClosedSweepItem {
  readonly id: string;
  readonly issueNumber: number;
  readonly status: string;
  readonly state: string;
}

export interface ClosedSweepDeps {
  readonly listItems: () => Promise<readonly ClosedSweepItem[]>;
  readonly setItemStatusToDone: (itemId: string) => Promise<void>;
}

export async function runClosedSweep(deps: ClosedSweepDeps): Promise<void> {
  const items = await deps.listItems();
  for (const item of items) {
    if (item.state !== "CLOSED") continue;
    if (item.status === "Done") continue;
    await deps.setItemStatusToDone(item.id);
  }
}
