# Spec — `src/loop/runDoneCleanup.ts` (`runDoneCleanup`)

Ticket: #57 — Land `src/loop/runDoneCleanup.ts` — strip pipeline labels for Done tickets.

## Files to read first

- `src/pipeline/decisions.ts` (full, 50 lines) — `decideLabelDelta` signature + filter algorithm. The strip semantics (`before.labels.filter(l => !afterSet.has(l) && stripPrefixes.some(...))`) are the load-bearing detail this runner exploits — passing an empty `after.labels` makes every strip-prefix-matched current label fall into `delta.remove`.
- `src/pipeline/transitions.ts:85-90` — the `In Documentation → Done` row. Its `strips: ["ready:*", "needs-rework:*"]` is the rule this runner re-applies; the runner names this row explicitly when calling `decideLabelDelta`.
- `src/github/labels.ts:54-59` — `removeLabel`'s GET-then-PUT-only-if-present idempotency. This is the second idempotency layer (the first is `decideLabelDelta` returning empty `remove` when nothing matches).
- `src/github/project-client.ts:24-31, 125-149` — `ProjectItem` shape (`id`, `issueNumber`, `status`, `labels`) and `listItemsInBoardOrder`. `status` is a string ("Done", "In Documentation", …); the runner filters on `status === "Done"`.
- `src/pipeline/auto-advance.ts` (full, 56 lines) — closest sibling for *shape* (top-of-file equation comment, narrow types, single exported function, internal helpers). The runner is async I/O (not pure), but the file silhouette is the same.
- `test/github/labels.test.ts:9-52` — the `makeTransport(routes)` recording-fake idiom + `RecordingTransport` typing. The runner test will hand-roll a parallel fake for the project client and reuse this idiom for the labels client (DI'd as a narrow port, see § Design).
- `test/pipeline/decisions.test.ts:43-47` — the `In Documentation → Done` expected-delta entry. Confirms the runner's call shape (`before` carrying `ready:documentation`, `after.labels = []`, `delta.remove = ["ready:documentation"]`).
- `CLAUDE.md` § "decideLabelDelta is the only place labels mutate" — the constraint this runner satisfies. It does not branch on label names directly; the strip set is read from the transition table by the pure decision function.
- `CLAUDE.md` § "Belt-and-suspenders" — the runner is the dispatcher-side safety net for "drift in Done labels". Two idempotency layers (`decideLabelDelta` and `removeLabel`) together cap the cost of an extra invocation at zero GitHub mutations.
- `CLAUDE.md` § "Test-first" — RED → GREEN. Write `test/loop/runDoneCleanup.test.ts` first, watch it fail, then implement.

## Context

Tickets in the Done column are terminal. Per the `In Documentation → Done` row in `TRANSITIONS`, entry into Done strips `ready:*` and `needs-rework:*`. But the auto-advance path that drives that transition isn't the only way labels enter Done state — e.g. a human re-applies `ready:po` to a closed ticket, or a ticket gets manually moved to Done from a non-canonical column (no transition row covers that). Those cases leave stale pipeline labels that `selectDispatches` / `decideAutoAdvance` would then have to defensively ignore.

`runDoneCleanup` is the deterministic safety net: each cycle, every Done item is re-asserted against the entry transition's strip rule. This is one of the four maintenance routines that run per dispatch cycle (the others — closed sweep, auto-merge, rework routing — land in their own tickets). All four are dispatcher I/O orchestrators on top of `src/pipeline/` decisions and `src/github/` primitives.

This is the **first file under `src/loop/`** — there is no existing sibling file in this directory to mirror. Mirror the *shape* of `src/pipeline/auto-advance.ts` (top comment block placing the runner in the dispatcher architecture, narrow types co-located, single exported function with internal helpers), but accept that the *contents* are async I/O orchestration, not pure decisions.

## Design

### New file: `src/loop/runDoneCleanup.ts`

```ts
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
// GitHubProjectClient / GitHubLabelsClient as a whole. Per CLAUDE.md narrow
// types: the test wires hand-rolled fakes; the production launcher passes
// `client.listItemsInBoardOrder.bind(client)` and similar.
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
    const delta = decideLabelDelta(
      // Re-apply the entry transition's strip rule. The "before" column is
      // fictitious — the actual current column is "Done" — but the
      // semantics is "if this ticket were to enter Done now, what would
      // get stripped?". The transition table owns the strip-prefix list;
      // this caller does not.
      { column: "In Documentation", labels: item.labels as readonly Label[] },
      // Empty `after.labels` maximises the strip filter: every current
      // label that is (a) not in afterSet and (b) matches a strip prefix
      // falls into delta.remove. Non-strip-matched labels (e.g. size:s,
      // priority:normal) are NOT removed because they fail predicate (b).
      { column: "Done", labels: [] },
    );
    for (const name of delta.remove) {
      await deps.removeLabel(item.issueNumber, name);
    }
  }
}
```

### The `decideLabelDelta` call shape (load-bearing)

The function is invoked with:

- `before = { column: "In Documentation", labels: <current labels> }`
- `after  = { column: "Done", labels: [] }`

Under decisions.ts's algorithm:

```
remove = before.labels.filter(
  (l) => !afterSet.has(l) && stripPrefixes.some((px) => l.startsWith(px))
);
```

`afterSet` is empty, so `!afterSet.has(l)` is trivially true for every current label. The strip-prefix predicate (from the `In Documentation → Done` row's `strips: ["ready:*", "needs-rework:*"]`) is the actual filter. Result: `delta.remove` is exactly the current labels matching `ready:*` or `needs-rework:*`. `delta.add` is `[]` because `after.labels` is empty (no label can be in `after \ before` when `after` is empty).

The "fictitious before column" framing matters because the runner satisfies the CLAUDE.md "decideLabelDelta is the only place labels mutate" rule without re-encoding the strip prefixes in this file. If the strip rule changes (a new pipeline label is added, the entry transition's strip set widens), this runner picks it up automatically by reading the transition table.

### `Label` cast on `item.labels`

`ProjectItem.labels` is `readonly string[]` (it carries every label on the issue, including `size:*` / `priority:*` / `wip:*` that aren't in the `Label` union). `decideLabelDelta`'s parameter type is `readonly Label[]`. The cast is structurally safe: `decideLabelDelta` only inspects labels via `.startsWith(...)` and `.includes(...)`, neither of which depends on the closed union — non-`Label` strings simply fail the strip-prefix test and are passed through unchanged. The narrow union exists for compile-time hygiene at decision sites; this caller is an I/O orchestrator that intentionally widens.

A `validateLabels(item.labels)` filter that drops non-`Label` strings before the call would be wrong: it would also drop `wip:*` and `error:*` strings, none of which need cleanup anyway, but the filter would mask future strip-prefix additions (e.g. if `wip:*` were ever added to the strip set). Pass the labels through; let the strip-prefix predicate decide.

### Why this runner is not pure

The two existing siblings under `src/pipeline/` (`decideAutoAdvance`, `decideReworkRouting`) are pure functions that emit decisions. This runner is a different shape: it owns I/O — both reading items and applying mutations — and exists in `src/loop/` rather than `src/pipeline/` for that reason. Per CLAUDE.md "Pure functions in `src/pipeline/`, I/O at the edges", `src/loop/` is one of the I/O edges. The pure decision still lives in `decideLabelDelta`; this runner just orchestrates the read-decide-write cycle around it.

### `for await` vs `Promise.all`

Sequential `for...of` with per-issue `await` is the deliberate shape. The Done column is small (terminal items get archived/closed downstream); parallelism would add complexity without meaningful speed-up. More importantly: GitHub label-mutation endpoints have low rate-limit budget at the per-issue level, and the labels client itself is GET-then-PUT (two round-trips per label removal) — bursting in parallel would amplify both. Sequential is the conservative default; switch to `Promise.all` only if profiling shows latency mattering.

### What `runDoneCleanup` does NOT do

- **Does not auto-advance In Documentation → Done.** That's a different runner (the `runAutoMerge` / forward auto-advance path) — see ticket comment chain. This one only handles drift *after* Done is reached.
- **Does not add labels.** `delta.add` is always `[]` for this call shape; the function ignores it. (Asserting `delta.add.length === 0` in code would be defensive code for an impossible state — skip it.)
- **Does not close issues, archive cards, or mutate Status.** Done is terminal in the pipeline's view; column-level housekeeping is the closed-sweep runner's concern (separate ticket).
- **Does not retry on transport errors.** `removeLabel` propagates verbatim; an error aborts the cycle and surfaces to the loop runner, which handles retry/backoff at its own layer (per `src/github/labels.ts`'s no-catch posture). A try/catch here would swallow a real GitHub outage.

## Concurrency model

None within this runner. Sequential async iteration over Done items, sequential `removeLabel` per item. The dispatcher loop (separate ticket) is responsible for invoking `runDoneCleanup` exactly once per cycle, serialised against the other maintenance routines.

## Error handling

No try/catch in this runner. `listItems` and `removeLabel` propagate transport errors verbatim, matching the no-catch posture of `src/github/labels.ts` and `src/github/project-client.ts`. The loop runner (consumer ticket) decides whether to abort the cycle, log-and-continue to the next routine, or trip a circuit breaker.

The one structural error case worth naming: `decideLabelDelta` throws if `(before.column, after.column)` is not in the transition table. The hardcoded `("In Documentation", "Done")` pair *is* in the table (transitions.ts:85-90), so this throw is unreachable from this file — the test for "In Documentation → Done is in the table" already lives in `decisions.test.ts`.

## Test plan (RED first)

Create `test/loop/runDoneCleanup.test.ts`. Hand-roll fakes for both ports — no `GitHubProjectClient` / `GitHubLabelsClient` instantiation, no transport mocks. The narrow `DoneCleanupDeps` shape is small enough that a fake is two object literals.

Required cases (the two AC cases plus a small set of structural guards — keep the test footprint XS):

| Case (`describe` / `it`) | Setup | Expected |
| --- | --- | --- |
| **happy path: Done ticket with stale pipeline labels — strips them** | One Done item, labels `["ready:po", "size:s", "needs-rework:architect", "priority:normal"]` | `removeLabel` called with `(n, "ready:po")` and `(n, "needs-rework:architect")`. NOT called with `"size:s"` or `"priority:normal"`. Total `removeLabel` calls: 2. |
| **idempotency: Done ticket with no pipeline labels — no mutations** | One Done item, labels `["size:s", "priority:normal"]` | `removeLabel` called zero times. (`listItems` called once.) |
| **non-Done items skipped** | Mix of items: one Done with `["ready:po"]`, one "In Architecture" with `["ready:architect"]` | `removeLabel` called once, with the Done ticket's number + `"ready:po"`. The "In Architecture" item's labels are untouched. |
| **multiple Done items processed sequentially** | Two Done items, both with `["ready:documentation"]` | `removeLabel` called twice, once per issue, in iteration order. Each call uses the matching `issueNumber`. |

The fake's `removeLabel` records `(number, name)` tuples in a list; assertions deep-equal that list. The fake's `listItems` returns a fixture array.

### What NOT to test

- Don't re-test `decideLabelDelta`'s strip-prefix algorithm — `decisions.test.ts` already covers per-row delta correctness, and the `In Documentation → Done` entry there pins the exact `delta.remove` shape this runner depends on.
- Don't re-test `removeLabel`'s GET-then-PUT-only-if-present idempotency — `labels.test.ts` already pins it. The runner relies on it but doesn't re-prove it.
- Don't test transport-error propagation — same reason; `labels.test.ts` covers `addLabel` propagation explicitly, and the no-catch posture is structural in this file (visible at code review by the absence of try/catch).
- Don't add a "0 items" / "empty Done column" case — covered structurally by the for-loop's natural empty behavior; not worth the line.

## Open questions

None. The ticket body specifies the function name, the DI shape (project client + label ops), the strip mechanism (via `decideLabelDelta`), and the two AC test cases. No discretionary calls remain; the spec just makes the `decideLabelDelta` call shape explicit so the developer doesn't reinvent it.

## Out of scope (do not implement here)

- Forward auto-advance for `In Documentation → Done`. Different runner, different ticket.
- The other three maintenance routines (closed sweep, auto-merge, rework routing) — separate tickets.
- Wiring `runDoneCleanup` into the dispatcher loop (`src/dispatch-bin.ts` or a future `src/loop/run.ts`). Call site lands with the loop-orchestration ticket.
- Production wiring of `DoneCleanupDeps` against `GitHubProjectClient` / `GitHubLabelsClient`. The launcher does this in one or two lines when the loop runner is wired up.
- Promotion of the test fakes to `test/loop/_helpers/`. Wait for a second consumer.
- Adding `runDoneCleanup` to a barrel re-export — CLAUDE.md forbids internal barrels.

## Definition of done

- `src/loop/runDoneCleanup.ts` exists, exports `runDoneCleanup`, `DoneCleanupDeps`, `DoneCleanupItem`. ≤80 lines of production code (target ~40-50).
- `test/loop/runDoneCleanup.test.ts` exists with the four cases above. All green.
- `pnpm typecheck && pnpm test` clean.
- No try/catch in `runDoneCleanup.ts` (`rg -n 'try \{|catch' src/loop/runDoneCleanup.ts` must return zero hits).
- This file does not import from any `src/github/` module — it talks to the narrow `DoneCleanupDeps` ports. (`rg -n "from \"\\.\\./github" src/loop/runDoneCleanup.ts` must return zero hits.)
- No edits to `src/pipeline/decisions.ts`, `src/pipeline/transitions.ts`, `src/github/labels.ts`, `src/github/project-client.ts`. Read-only consumers.
- Spec file committed alongside the implementation.
