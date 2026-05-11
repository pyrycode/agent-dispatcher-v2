# Spec — #58 `src/loop/runClosedSweep.ts`

Move closed GitHub issues out of pre-Done project columns into Done each dispatch cycle.

## Files to read first

- `src/loop/runDoneCleanup.ts` (whole file, 53 lines) — the sibling sweep this runner mirrors. Same shape: narrow ports, `for…of` over `listItems()`, no internal branching on column or label names. Match its style 1:1.
- `test/loop/runDoneCleanup.test.ts` (whole file, 80 lines) — copy the recorder pattern verbatim. The recorder shape (`{ deps, removals, listCalls }`) carries over with one rename (`statusSets` instead of `removals`).
- `src/github/project-client.ts:24-31` — current `ProjectItem` shape. You'll widen with a `state` field (additive, no consumer reads it yet).
- `src/github/project-client.ts:50` — `ITEMS_QUERY`. Add `state` inside the `Issue` inline fragment: `content{... on Issue{state number title url labels(...)}}`.
- `src/github/project-client.ts:67-76` — `ItemNode` / `RawIssue`-style shape. Add `state?: unknown` to the content type.
- `src/github/project-client.ts:152-171` — `mapItem`. Coerce `state` with the same `typeof === "string"` guard the surrounding code uses for `title`/`url`.
- `src/github/project-client.ts:87-123` — `GitHubProjectClient` constructor + `initialize`. Note `statusOptionIdsByName: ReadonlyMap<string, string>` is already cached at init time — that's the lookup `setItemStatus` consumes. No re-fetch needed.
- `src/github/blocked-by.ts` (whole file, 39 lines) — reference for adding a mutation primitive. Mirror its: load-bearing-invariants header comment, `transport(MUTATION, vars)` shape, no try/catch.
- `src/pipeline/transitions.ts:14-22` — `Column` type. `"Done"` is a string literal — not exported separately. The runner compares against the string `"Done"` directly (same as `runDoneCleanup.ts:39`).
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — this runner is an I/O orchestrator, not a pure function. Predicate logic is one line; do NOT extract it to `src/pipeline/` (CLAUDE.md: "The 'closed but not in Done' predicate is small; if it grows non-trivial extract a pure function"). Inline is correct for this ticket.
- `CLAUDE.md` § "200-line hardcap" — both touched files stay well under.

## Context

GitHub's "close issue" action does NOT move the project board item out of its current column. v1's lesson: *"Closed GitHub issue ≠ removed from project board."* If a ticket is closed while sitting in (say) `In Code Review`, the dispatcher's selection pass will keep re-considering it. This sweep is the deterministic reconciliation that catches that drift each cycle.

This is one of four per-cycle maintenance routines. The other three are tracked separately:

- Done cleanup → `runDoneCleanup` (#57, already shipped)
- Auto-merge → separate ticket
- Rework routing → separate ticket

## Design

### Two changes in `src/github/project-client.ts`

**(1) Widen `ProjectItem` with `state`.** Project items already carry the linked issue's `state` in the GraphQL response — we just don't request it today. Add it.

```typescript
export interface ProjectItem {
  readonly id: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly status: string;
  readonly labels: readonly string[];
  readonly url: string;
  readonly state: string;   // "OPEN" | "CLOSED" (GraphQL enum — uppercase)
}
```

Changes required:
- `ITEMS_QUERY`: add `state` inside the `... on Issue{…}` inline fragment.
- `ItemNode.content`: add `readonly state?: unknown`.
- `mapItem`: extract with the same `typeof === "string"` guard pattern used for `title`/`url`. Default `""` on missing/malformed.

Rationale: this matches the existing widening guidance in the file header — *"sibling tickets widen when they need body / blockedBy / etc."* — #58 is exactly such a sibling. Additive change; no existing consumer reads `state` yet. `codegraph_impact ProjectItem` confirms zero external touchpoints beyond the file itself.

**(2) Add `setItemStatus` method to `GitHubProjectClient`.**

```typescript
private static readonly SET_STATUS_MUTATION =
  "mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$optionId}}){projectV2Item{id}}}";

async setItemStatus(itemId: string, statusName: string): Promise<void> {
  const optionId = this.statusOptionIdsByName.get(statusName);
  if (!optionId) {
    throw new Error(`setItemStatus: no Status option named "${statusName}"`);
  }
  await this.transport(GitHubProjectClient.SET_STATUS_MUTATION, {
    projectId: this.projectId,
    itemId,
    fieldId: this.statusFieldId,
    optionId,
  });
}
```

Two invariants worth a one-line header comment above the method:

- Takes the **project item id** (`ProjectItem.id`), NOT the issue number. Mixing the two yields `Could not resolve to a node`.
- Resolves `optionId` via the cached `statusOptionIdsByName` map populated at `initialize`. No round-trip; no fallback. Missing option name → throw with the option name in the message (covers misconfigured boards).

Errors propagate verbatim (same posture as `addBlockedBy`).

### New file `src/loop/runClosedSweep.ts`

Narrow-port shape mirrors `runDoneCleanup` exactly:

```typescript
// Per-cycle maintenance routine: move CLOSED issues sitting in pre-Done
// columns into Done so the dispatcher's selection pass doesn't re-dispatch
// them. Backstops the v1 lesson "Closed GitHub issue ≠ removed from
// project board" with a deterministic each-cycle reconciliation.
//
// Idempotency: the predicate skips items whose Status is already "Done",
// so a repeat invocation issues zero mutations. Per CLAUDE.md "The 'closed
// but not in Done' predicate is small; if it grows non-trivial extract a
// pure function" — it doesn't grow here. Inline stays.

export interface ClosedSweepItem {
  readonly id: string;            // project item id (for setItemStatus)
  readonly issueNumber: number;   // logged in error context if needed
  readonly status: string;        // current project Status column
  readonly state: string;         // "OPEN" | "CLOSED"
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
```

Notes on the port shape:

- `setItemStatusToDone(itemId)` is intentionally narrower than the underlying `setItemStatus(itemId, statusName)` — the runner only ever moves to Done, so the production wiring closes over `"Done"` and the test fake takes one arg. This keeps the runner contract free of magic strings and means the test recorder records *one* thing per call.
- No `issuesClient` dependency despite the AC's mention. Rationale: the issue's CLOSED state is already in the project-board GraphQL response (after the (1) widening). Adding a REST `getIssue` per item is N+1 calls for data we already have. The "DI for fakes" point in the AC is satisfied by `ClosedSweepDeps` alone — the test wires fake `listItems` + fake `setItemStatusToDone` without touching either real client. Flagging this as an architect-side deviation from the AC's literal wording, with the same rationale `runDoneCleanup` already follows (it also accepts only the data + mutation it needs, not the full clients).

### Production wiring (out of scope for this ticket)

The launcher / cycle-runner that calls `runClosedSweep` does not exist yet — it lands in a later ticket alongside the other three maintenance routines. When that ticket lands, wiring will look like:

```typescript
await runClosedSweep({
  listItems: () => projectClient.listItemsInBoardOrder(),  // already returns id+status+state after widening
  setItemStatusToDone: (itemId) => projectClient.setItemStatus(itemId, "Done"),
});
```

`ProjectItem` is structurally compatible with `ClosedSweepItem` — extra fields on the source are fine (TypeScript width-subtyping). No adapter needed.

## Data flow

```
listItemsInBoardOrder() ──► [ProjectItem, …]              (GraphQL: 1 paginated read)
                              │
                              ▼
                  runClosedSweep filters:
                  state === "CLOSED" && status !== "Done"
                              │
                              ▼  per match
                  setItemStatus(item.id, "Done")           (GraphQL mutation, 1 per match)
```

Zero matches → one GraphQL read, zero mutations (idempotency).

## Concurrency model

Sequential `for…of` with `await`, identical to `runDoneCleanup`. No `Promise.all` — these mutations are rare per cycle (closed-but-not-Done is a recovery case, not a steady state), and serial keeps order deterministic for tests + log reading. If this routine ever becomes hot, fan-out is a follow-up.

No `AbortSignal` parameter. The per-cycle maintenance routines run inline in the dispatch loop; cancellation is the loop's concern, not each runner's. (`runDoneCleanup` is the precedent.)

## Error handling

`setItemStatus` errors propagate. A failure on item N aborts the sweep before items N+1…M are processed. Acceptable because: (a) the sweep is idempotent and will retry next cycle; (b) failing fast surfaces auth/rate-limit/project-misconfig issues immediately rather than silently dropping work. Same posture as `addBlockedBy` and `runDoneCleanup` (which lets `removeLabel` throw upward).

No retries, no try/catch in the runner. If we observe transient failures in practice, retry policy lands as a separate ticket (per CLAUDE.md "Don't write a defense for a failure mode that hasn't been observed").

## Testing strategy

`test/loop/runClosedSweep.test.ts` — vitest, recorder fakes, no real GitHub. Copy the `makeRecorder` helper from `runDoneCleanup.test.ts` verbatim with one rename:

```typescript
interface Recorder {
  readonly deps: ClosedSweepDeps;
  readonly statusSets: Array<{ itemId: string }>;
  listCalls: number;
}
```

Four cases, mirroring `runDoneCleanup.test.ts` cardinality:

1. **Happy path** — `[{id:"PVTI_1", issueNumber:42, status:"In Code Review", state:"CLOSED"}]` → one `setItemStatusToDone("PVTI_1")` call.
2. **Idempotency** — `[{id:"PVTI_2", issueNumber:7, status:"Done", state:"CLOSED"}]` → zero mutations, one list call.
3. **OPEN items skipped** — `[{id:"PVTI_3", issueNumber:99, status:"In Code Review", state:"OPEN"}]` → zero mutations. Pins the predicate: the runner is gated on CLOSED, not just on column.
4. **Mixed batch ordering** — two CLOSED-in-pre-Done items + one CLOSED-in-Done + one OPEN-in-pre-Done → only the two pre-Done CLOSED items get mutated, in iteration order.

Cases (1) and (2) satisfy the AC verbatim. (3) and (4) are tiny additional pins matching the precedent set by `runDoneCleanup.test.ts` (which has two AC cases + two extras).

No test against the GraphQL transport directly — `project-client.ts` modifications are covered by extending its existing test file if one exists for `setItemStatus`. Check `test/github/project-client.test.ts` (if present) and:

- Add `state` to whatever mock GraphQL response shape it uses for `listItemsInBoardOrder` tests (additive, won't break existing assertions unless they deep-equal).
- Add a focused test for `setItemStatus`: asserts the mutation variables (`{projectId, itemId, fieldId, optionId}`) match the cached IDs, and that an unknown status name throws with the option name in the message.

If `test/github/project-client.test.ts` does NOT yet exist, do not create it for this ticket — flag as follow-up. (Per CLAUDE.md "Don't add a 'while I'm here' refactor in the middle of a ticket.")

## Open questions

1. **Status name "Done" — string literal or `Column` import?** `runDoneCleanup.ts:39` compares against the string `"Done"` directly without importing `Column`. Match that precedent: pass the literal `"Done"` at the production wiring site, no import. (The runner itself doesn't reference `"Done"` — the wiring does.)
2. **`state` field default in `mapItem`.** If the GraphQL response is malformed and `state` is missing, default to `""` (matches the `title`/`url` pattern). An empty string is neither `"OPEN"` nor `"CLOSED"`, so the runner skips it — safer than defaulting to one of the enum values.
3. **Should `setItemStatus` log the previous status for observability?** No — the runner is silent today (so is `runDoneCleanup`). Logging is the dispatch loop's concern when it wires these together.

## Edit fan-out

`codegraph_impact ProjectItem` → 2 hits, both inside `src/github/project-client.ts`. Widening is additive (new field, optional in GraphQL response). Zero external call-site updates required.

Production-line estimate: ~30 lines added in `project-client.ts` (query + type + mapItem + mutation method) + ~40 lines new in `runClosedSweep.ts` = ~70 lines. Test file ~85 lines (doesn't count toward size). New exported types: 2. Files modified or created: 3 (2 prod + 1 test). All red lines clear.
