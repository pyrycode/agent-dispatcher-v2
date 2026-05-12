# Spec — #59 `src/loop/runAutoMerge.ts`

Merge ready PRs attached to Done-column items each dispatch cycle, and roll the ticket back to **In Code Review** when the merge attempt surfaces a conflict.

## Files to read first

- `src/loop/runClosedSweep.ts` (whole file, 35 lines) — sibling maintenance routine that shipped two days ago (#58). Same shape this spec adopts: narrow ports, `for…of` over `listItems()`, predicate inline, closed-over status name on the rollback dep. Match its style 1:1.
- `test/loop/runClosedSweep.test.ts` (whole file, 68 lines) — copy the recorder pattern verbatim; the only changes are the extra `prs` field on each item, the extra `mergePr` recorder slot, and one extra "rollback" assertion in the conflict case.
- `src/loop/runDoneCleanup.ts` (whole file, 53 lines) — the other shipped maintenance routine. Confirms the narrow-port idiom and inline-predicate posture across both prior runners.
- `src/github/pr.ts:40-46` — `MergeResult` discriminated union. The runner branches on `result.merged === false && result.reason === "conflict"`. The `"other"` variant is NOT a rollback trigger (see § Error handling).
- `src/github/pr.ts:117-126` — `mergePr` body. Confirms conflict is returned as a typed value, never thrown. The runner's narrow port has signature `(prNumber: number) => Promise<MergeResult>`.
- `src/pipeline/find-ready-pr.ts` (whole file, 42 lines) — pure predicate this runner composes. The runner imports `findReadyPrNumber` and the type `ReadyPrCandidate` directly; no wrapper.
- `test/pipeline/find-ready-pr.test.ts:1-26` — `ReadyPrCandidate` shape + the `mkPr` test helper. Construct test PRs the same way (`number`, `nodeId`, `url`, `isDraft`, `labels`).
- `src/github/project-client.ts:24-35` — `ProjectItem` shape, including the `id` field. The runner reuses `ProjectItem.id` for the rollback `setItemStatus` call (NOT the issue number).
- `src/github/project-client.ts:137-148` — `setItemStatus(itemId, statusName)`. Note `"In Code Review"` must be present in the cached `statusOptionIdsByName` map — it is, because `"In Code Review"` is one of the seven `Column` values populated at `initialize` time.
- `src/pipeline/transitions.ts:14-22` — `Column` type. `"Done"` and `"In Code Review"` are string literals, not exported separately. The runner compares against the string `"Done"` directly (precedent: `runDoneCleanup.ts:39`, `runClosedSweep.ts:31`); the rollback target `"In Code Review"` is the string the production wiring closes over (precedent: `runClosedSweep.ts`'s `setItemStatusToDone` closure pattern).
- `docs/specs/architecture/58-runClosedSweep.md` (whole file, 202 lines) — the spec this one mirrors structurally. The narrow-port-with-closed-over-status-name decision and the "wiring is out of scope" stance are both inherited from there.
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — this runner is an I/O orchestrator. Predicate logic (`status === "Done"`, `result.merged === false && result.reason === "conflict"`) is one branch each; do NOT extract to `src/pipeline/`.
- `CLAUDE.md` § "Belt-and-suspenders" — the v1 #218 lesson (silent re-dispatch of closed-but-unmerged tickets) is the *observed* failure this rollback prevents. The deterministic safety net is the rollback itself.
- `CLAUDE.md` § "200-line hardcap" — runner lands well under (~50 lines).

## Context

When the developer agent completes its stage it produces a PR. The pipeline auto-advances the ticket toward Done expecting the PR to merge. The dispatcher attempts that merge each cycle. Two observed failure modes shaped this design:

1. **v1 #218 (morning incident).** Without a rollback, a PR that fails to merge on conflict leaves its ticket sitting in `Done` with an open PR. The closed-sweep routine (#58) then considers anything in `Done` terminal, and the dispatcher's selection pass silently re-dispatches the ticket through stages it has already passed. The fix: surface conflicts to a human by rolling the ticket's project Status back from `Done` to `In Code Review`, where review tooling and human attention are already concentrated.

2. **Closed PR ≠ merged PR.** A conflict is not the only way `mergePr` fails (transport errors, auth, rate limits — `reason: "other"`). Those failures are transient; the next cycle retries automatically. Rolling back on `"other"` would create a thrash loop. Only the `conflict` variant triggers the rollback.

This routine is one of four per-cycle maintenance routines. The other three:

- Done cleanup → `runDoneCleanup` (#57, shipped)
- Closed sweep → `runClosedSweep` (#58, shipped)
- Rework routing → separate ticket (#60)

The launcher that orchestrates all four lands in a later ticket; this spec only delivers `runAutoMerge` + its test.

## Design

### New file `src/loop/runAutoMerge.ts`

The runner shape mirrors `runClosedSweep` exactly: a narrow `Deps` interface with one port per I/O concern, closed-over status names so the runner contract carries no magic strings, no `AbortSignal`, no retry, no `try/catch` inside the runner.

```typescript
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
//      candidates are all drafts / error-labeled. Per CLAUDE.md
//      "decideLabelDelta is the only place labels mutate" the rollback is
//      a Status mutation, NOT a label mutation, so it does not pass
//      through the transition table — same posture as runClosedSweep's
//      move-to-Done.
//
// Rollback variant gate: ONLY `MergeResult.reason === "conflict"` triggers
// the Status rollback. `reason === "other"` is treated as transient — the
// PR stays open, the ticket stays in Done, and the next cycle retries.
// Per CLAUDE.md "Don't write a defense for a failure mode that hasn't
// been observed" — silent stuck-in-Done loops on permanent "other"
// failures are a follow-up if observed.

import { findReadyPrNumber, type ReadyPrCandidate } from "../pipeline/find-ready-pr.ts";
import type { MergeResult } from "../github/pr.ts";

// Narrow ports — only the data + mutations this runner actually consumes.
// `setItemStatusToInCodeReview` is intentionally narrower than the
// underlying `setItemStatus(itemId, statusName)` so the runner contract
// carries no magic string and the test fake records one thing per call.
// Same pattern as runClosedSweep's `setItemStatusToDone`.
export interface AutoMergeItem {
  readonly id: string;             // project item id (for setItemStatusToInCodeReview)
  readonly issueNumber: number;    // upstream uses to find the candidate PRs
  readonly status: string;         // current project Status column
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
```

### Why `listPrsForItem` is a runner-level port (not pre-attached in `AutoMergeItem`)

Two alternatives were considered:

**(A) Widen `AutoMergeItem` with `prs: readonly ReadyPrCandidate[]`** — the upstream `listItems` returns each item already paired with its candidate PRs.

**(B) Keep PR discovery as a separate port** — the runner calls `listPrsForItem(item)` per Done-column item.

The spec picks **(B)** for three reasons:

1. **No upstream helper exists yet.** `src/github/pr.ts` ships `createPr`, `enableAutoMerge`, `mergePr`. There is no `listPrsForBranch` or `listPrsForIssue` query. Wiring the runner to a not-yet-existent shape would either (a) force this ticket to expand into `src/github/pr.ts` (red-line size violation), or (b) embed an empty-array placeholder in the data shape (defense for an unobserved failure mode). Keeping PR discovery as a port lets the listing helper land separately when the launcher ticket consumes it.

2. **Avoids the N+1 cost where it doesn't apply.** Most cycles, zero or one ticket is in Done with a non-trivial PR set. The fan-out from `listPrsForItem` is bounded by Done-column cardinality, which is small by construction (Done is terminal; cleanup runs each cycle).

3. **Mirrors the sibling spec's wiring deferral.** `runClosedSweep` (#58) explicitly deferred launcher wiring: *"The launcher / cycle-runner that calls `runClosedSweep` does not exist yet — it lands in a later ticket."* This spec follows the same posture. The launcher ticket will close over whatever list-PRs helper has materialized by then.

### Production wiring (out of scope for this ticket)

When the launcher ticket lands, wiring will look like (sketch — exact helper names depend on what the later ticket adds to `src/github/pr.ts`):

```typescript
await runAutoMerge({
  listItems: () => projectClient.listItemsInBoardOrder(),
  listPrsForItem: (item) => prClient.listOpenPrsForBranch(`feature/${item.issueNumber}`),
  mergePr: (n) => prClient.mergePr(n),
  setItemStatusToInCodeReview: (id) => projectClient.setItemStatus(id, "In Code Review"),
});
```

`ProjectItem` is structurally compatible with `AutoMergeItem` (extra fields fine; TypeScript width-subtyping). `MergeResult` flows verbatim from `prClient.mergePr`. No adapters needed at the wiring site.

## Data flow

```
listItems() ──► [AutoMergeItem, …]                             (1 paginated read upstream)
                  │
                  ▼ filter item.status === "Done"
listPrsForItem(item) ──► [ReadyPrCandidate, …]                 (1 query per Done item)
                  │
                  ▼ findReadyPrNumber(prs)
                  │
              ┌───┴───┐
              ▼       ▼
            null    number
            skip      │
                      ▼
              mergePr(prNumber) ──► MergeResult                (1 mutation per ready Done item)
                      │
                  ┌───┴───┐
                  ▼       ▼
              merged    {merged:false, reason}
              done!       │
                     ┌────┴────┐
                     ▼         ▼
                 "conflict"  "other"
                     │         │
                     ▼         (no-op; PR + ticket unchanged this cycle)
       setItemStatusToInCodeReview(item.id)                   (1 mutation per conflict)
```

Zero Done items, or zero ready PRs across all Done items → one list read, zero mutations.

## Concurrency model

Sequential `for…of` with `await`, identical to `runClosedSweep` and `runDoneCleanup`. No `Promise.all`:

- Done-column cardinality is small.
- Sequential keeps log order deterministic — useful both for tests and for humans triaging conflicts.
- `mergePr` followed conditionally by `setItemStatusToInCodeReview` is one logical sub-step; order must be preserved.

No `AbortSignal` parameter. The per-cycle maintenance routines run inline in the dispatch loop; cancellation is the loop's concern, not each runner's (precedent: `runClosedSweep`, `runDoneCleanup`).

## Error handling

The runner is the deterministic safety net for v1 #218 (silent re-dispatch). Two failure surfaces:

**(1) `mergePr` returns a typed `MergeResult` — never throws.** That is the load-bearing invariant pinned by `test/github/pr.test.ts:202-223`. The runner branches on the discriminant:

- `result.merged === true` → done.
- `result.merged === false && result.reason === "conflict"` → call `setItemStatusToInCodeReview(item.id)`.
- `result.merged === false && result.reason === "other"` → no-op for this cycle. The PR stays open; ticket stays in Done; the next cycle retries. **No rollback on "other"** — see § Context point (2).

**(2) `listItems`, `listPrsForItem`, `setItemStatusToInCodeReview` errors propagate.** Same posture as `runClosedSweep` and `runDoneCleanup`: a failure on item N aborts the sweep before items N+1…M are processed. Acceptable because (a) the runner is idempotent and the next cycle will retry; (b) failing fast surfaces auth / rate-limit / project-misconfig issues immediately rather than silently dropping work.

No retries, no `try/catch` inside the runner. If we observe transient `"other"` failures keeping a ticket permanently stuck in Done with an unmerged PR, retry policy lands as a separate ticket. Per CLAUDE.md *"Don't write a defense for a failure mode that hasn't been observed."*

## Testing strategy

`test/loop/runAutoMerge.test.ts` — vitest, recorder fakes, no real GitHub. Copy the `makeRecorder` helper from `test/loop/runClosedSweep.test.ts` and extend.

Recorder shape:

```typescript
interface Recorder {
  readonly deps: AutoMergeDeps;
  readonly mergeCalls: number[];                 // PR numbers passed to mergePr
  readonly rollbacks: Array<{ itemId: string }>; // setItemStatusToInCodeReview calls
  listCalls: number;
}
```

Each `AutoMergeItem` in the fake `listItems` carries a parallel-array `prs` map keyed by issue number, so the fake `listPrsForItem(item)` returns the right candidate list. Fake `mergePr` is a routing table: per PR number, return either `{merged:true}` or the conflict / other variant. PR-info construction reuses the `mkPr` helper shape from `test/pipeline/find-ready-pr.test.ts:18-26` (inline; no shared helper — same posture as the existing per-test inline copies).

The four AC-tied cases plus three predicate-completeness pins:

1. **AC (a) — Happy path: ready PR merges, ticket stays in Done.** One Done item with one ready PR; `mergePr` returns `{merged:true}`. Assertions: `mergeCalls === [<pr>]`, `rollbacks === []`.

2. **AC (b) — Conflict rollback.** One Done item with one ready PR; `mergePr` returns `{merged:false, reason:"conflict", error}`. Assertions: `mergeCalls === [<pr>]`, `rollbacks === [{itemId: <id>}]`.

3. **AC idempotency #1 — Done item whose PR is already merged (no candidates returned).** `listPrsForItem` returns `[]` → `findReadyPrNumber` returns `null`. Assertions: `mergeCalls === []`, `rollbacks === []`, `listCalls === 1`.

4. **AC idempotency #2 — Done item whose only candidate is a draft.** `listPrsForItem` returns `[mkPr(<n>, /*draft*/ true, [])]` → `findReadyPrNumber` returns `null`. Same assertions as (3).

5. **Predicate pin — non-Done items are skipped.** A single `In Code Review` item with a ready PR → no `listPrsForItem` call, no merge, no rollback. (Pins the `item.status !== "Done"` gate; rules out "list everything, then filter post-merge".)

6. **Predicate pin — `reason: "other"` does NOT trigger rollback.** One Done item with one ready PR; `mergePr` returns `{merged:false, reason:"other", error}`. Assertions: `mergeCalls === [<pr>]`, `rollbacks === []`. (Pins the discriminant on `"conflict"`, not on `!merged`.)

7. **Mixed batch — ordering is iteration order.** Two Done items, both with ready PRs; first merges cleanly, second hits conflict. Assertions: `mergeCalls === [<pr1>, <pr2>]` (in order), `rollbacks === [{itemId: <id2>}]`. Confirms the sweep does not abort early on a per-item rollback.

Cases (1) and (2) satisfy the literal AC list. Cases (3) and (4) cover the two idempotency clauses ("PR already merged" and "PR not ready"). Cases (5)–(7) are the same kind of small predicate pins `runClosedSweep.test.ts` carries beyond its AC minimum (cases 3 and 4 there) — three pins for three discriminant edges (column, conflict variant, batch ordering).

No test against the GraphQL transport directly — `mergePr` itself is covered by `test/github/pr.test.ts` (which already pins the typed-conflict semantic at line 202–223); `setItemStatus` is covered by `test/github/project-client.test.ts`.

## Open questions

1. **`reason: "other"` posture — confirm "no-op, retry next cycle".** v1 #218 was specifically a conflict incident. `mergePr` returning `"other"` is currently uncovered by an observed failure mode. The spec picks "no-op, no rollback, no throw" to match CLAUDE.md's evidence-based fix-selection rule. If review surfaces a different real-world case (e.g. permission denial that *should* surface to a human), that's a follow-up ticket — not a re-spec of this one.

2. **No `Column` import in the runner.** The runner compares `item.status` against the string `"Done"` directly. Precedent: `runDoneCleanup.ts:39`, `runClosedSweep.ts:31`. The rollback target `"In Code Review"` lives in the wiring closure, not in this file. (Same closed-over-status-name pattern as `runClosedSweep`'s `setItemStatusToDone`.)

3. **`listPrsForItem` shape — `(item)` vs `(issueNumber)`.** Picked `(item)` so the future helper has room to use either `item.id` (project-node-id-based query) or `item.issueNumber` (branch / linked-issue query) without changing the runner's contract. Cost: one extra field in the fake's `AutoMergeItem` constructor. Worth it.

## Edit fan-out

`codegraph_impact MergeResult` → 1 hit inside `src/github/pr.ts` (the discriminated-union definition itself); zero external consumers today. This runner adds the second consumer. Additive; no signature changes anywhere.

`codegraph_impact findReadyPrNumber` → confirms the pure predicate has no current callers in `src/`. This runner is its first caller, exactly as `find-ready-pr.ts:1-6` anticipated (*"shared between the dispatcher's loop (`runAutoMerge`) and the salvage flow"*).

Production-line estimate: ~50 lines new in `runAutoMerge.ts` (header comment + 2 exported interfaces + 12-line function body). Test file ~110 lines (doesn't count toward size). New exported types: 2 (`AutoMergeItem`, `AutoMergeDeps`). Files modified or created: 2 (1 prod + 1 test). All red lines clear.
