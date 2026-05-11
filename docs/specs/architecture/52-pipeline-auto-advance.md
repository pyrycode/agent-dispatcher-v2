# Spec — `src/pipeline/auto-advance.ts` (`decideAutoAdvance`)

Ticket: #52 — Land `src/pipeline/auto-advance.ts` — `decideAutoAdvance`.

## Files to read first

- `src/pipeline/selection.ts` (full, 90 lines) — **the canonical sibling**. Mirror its structure exactly: top-of-file equation comment placing this gate in the throughput chain, narrow types co-located, single exported pure function, internal `isEligible` / `hasWipLabel` helpers. Reuse the exported `SelectionItem` type from this file — do **not** redeclare it.
- `src/pipeline/blockers.ts:9-26` — `Blocker` shape and `hasOpenBlockers` predicate. Import `hasOpenBlockers` and call it; do not reimplement.
- `src/pipeline/transitions.ts:14-21` — `Column` type. Import and use as the `to` field's type.
- `test/pipeline/selection.test.ts` (full) — the test-file shape to mirror. Note the `mkState` helper pattern, the `describe` grouping by concern, and the fixture style (inline `SelectionItem[]` arrays).
- `CLAUDE.md` § "The throughput equation is `min(...)` of every gate" — the *reason* this slice exists. Quote the equation block verbatim in the file's top comment, matching `selection.ts`'s comment block.
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — no `await`, no `gh`, no `git`, no `fs`. Enforced by review.
- `CLAUDE.md` § "Test-first" — RED → GREEN. Write `test/pipeline/auto-advance.test.ts` first, watch it fail, then add the implementation.

## Context

The dispatcher's throughput equation (CLAUDE.md):

```
actual_wip = min(
  selectDispatches.cap,
  decideAutoAdvance.backlog_cap,
  blocker_chain,
  MANUAL_ADVANCE_GATES,
)
```

v1's `decideAutoAdvance` hardcoded `WIP = 1` while `selectDispatches` parameterised correctly. Bumping concurrency in one place silently failed because the other clamped to 1 (incident 2026-05-08, referenced in the ticket). v2's rule is: every gate that participates in throughput takes `maxConcurrent` as an argument.

This slice covers exactly one transition: `Backlog → In Architecture`. Forward auto-advance for other columns is explicitly out of scope (per ticket "Out of scope") and lands in follow-ups that will reuse this module's shape.

## Design

### New file: `src/pipeline/auto-advance.ts`

```ts
// Pure auto-advance decision function. Implements the
// `decideAutoAdvance.backlog_cap` term of CLAUDE.md's throughput equation:
//
//   actual_wip = min(
//     selectDispatches.cap,
//     decideAutoAdvance.backlog_cap,   ← here
//     blocker_chain,
//     MANUAL_ADVANCE_GATES,
//   )
//
// Walks caller-ordered items, filters Backlog rows by eligibility, emits
// promotions up to the effective capacity (maxConcurrent - inFlightCount).
// No await, no gh / git / fs — the I/O lives behind src/github/. See
// CLAUDE.md § "Pure functions in src/pipeline/, I/O at the edges".

import { hasOpenBlockers } from "./blockers.ts";
import { type SelectionItem } from "./selection.ts";
import type { Column } from "./transitions.ts";

export interface AutoAdvanceState {
  items: readonly SelectionItem[];
}

export interface AdvanceDecision {
  readonly issueNumber: number;
  readonly to: Column;
}

export function decideAutoAdvance(
  state: AutoAdvanceState,
  inFlightCount: number,
  maxConcurrent: number,
): AdvanceDecision[] {
  const capacity = Math.max(0, maxConcurrent - inFlightCount);
  if (capacity === 0) return [];
  const result: AdvanceDecision[] = [];
  for (const item of state.items) {
    if (result.length >= capacity) break;
    if (!isEligible(item)) continue;
    result.push({ issueNumber: item.issueNumber, to: "In Architecture" });
  }
  return result;
}

function isEligible(item: SelectionItem): boolean {
  if (item.column !== "Backlog") return false;
  if (!item.labels.includes("ready:po")) return false;
  if (hasWipLabel(item.labels)) return false;
  if (hasOpenBlockers(item.blockers)) return false;
  return true;
}

function hasWipLabel(labels: readonly string[]): boolean {
  return labels.some((l) => l.startsWith("wip:"));
}
```

### Type reuse, not duplication

`SelectionItem` already encodes the exact `{ column, issueNumber, labels, blockers }` shape this function needs. The ticket's AC explicitly forbids declaring a parallel type. Import and reuse.

The decision type is intentionally distinct from `selection.ts`'s `DispatchTuple`:

| Function           | Output                                       | Why distinct                                                            |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------------------- |
| `selectDispatches` | `{ agent: Agent; issueNumber: number }`      | Caller (`src/dispatch/`) routes by agent.                               |
| `decideAutoAdvance`| `{ issueNumber: number; to: Column }`        | Caller (`src/loop/`) mutates Status → calls `decideLabelDelta` with `to`. |

`to` is always `"In Architecture"` in this slice, but is emitted explicitly so the consumer's call into `decideLabelDelta(before, after)` needs no out-of-band lookup. When follow-up slices add `In Architecture → In Development` and so on, this shape extends without a breaking change — only the constant inside `decideAutoAdvance` (or its successor) changes.

### Capacity math

`capacity = Math.max(0, maxConcurrent - inFlightCount)` handles every input case in one expression:

- `maxConcurrent = 0` → `capacity = 0` regardless of `inFlightCount` → empty result.
- `inFlightCount > maxConcurrent` (transient over-capacity, e.g. mid-cycle) → `capacity = 0` → empty result, no throw.
- `inFlightCount < 0` (cannot happen — caller's GitHub query returns a count) → `capacity > maxConcurrent`, harmless: the for-loop's `result.length >= capacity` still terminates correctly.

No separate guard clause needed for negative `maxConcurrent`. `Math.max(0, ...)` collapses it to zero. (`selection.ts` uses `if (maxConcurrent <= 0) return [];` because its capacity *is* `maxConcurrent`; here capacity is a derived value, so the guard rides on `Math.max`.)

### Eligibility predicate

Four conjuncts, in cost order (cheapest first — short-circuit on the failures most common in practice):

1. `item.column === "Backlog"` — non-Backlog rows dominate `state.items` once steady-state is reached.
2. `item.labels.includes("ready:po")` — Backlog rows without `ready:po` are PO-rework or freshly-triaged.
3. `!hasWipLabel(item.labels)` — re-uses the `wip:*` prefix idiom from `selection.ts:87-89`. Worth duplicating the 3-liner rather than exporting a helper from `selection.ts`; the v2 rule is narrow types, narrow helpers, per module.
4. `!hasOpenBlockers(item.blockers)` — the costly one (array walk over blockers).

### Module-level data: none

Unlike `selection.ts` (which builds `COLUMN_TO_AGENT` from `AGENT_COLUMN_MAP` at module load), this module has no derived constants. `"In Architecture"` is the only literal and lives at the single emission site. No `let`, no module-scope `var`, no derived data.

## Test plan (RED first)

Create `test/pipeline/auto-advance.test.ts`, mirroring `test/pipeline/selection.test.ts`'s shape. Use the same `mkState` helper pattern, the same `describe` grouping by concern, the same inline-`SelectionItem[]` fixture style.

Required cases (all listed in the ticket; **do not** add speculative cases beyond these — keep the test footprint XS):

| Case (`describe` / `it`) | Inputs | Expected |
| --- | --- | --- |
| **capacity bounds: both-advance-same-cycle** | 2 eligible Backlog items, `maxConcurrent=2`, `inFlightCount=0` | Both decisions, in caller-supplied order |
| **capacity bounds: partial-in-flight-reduces-capacity** | 3 eligible Backlog items, `maxConcurrent=3`, `inFlightCount=1` | Exactly first 2 decisions |
| **capacity bounds: capacity-saturated-holds-all** | Eligible items, `inFlightCount === maxConcurrent` | `[]` |
| **capacity bounds: transient-over-capacity-clamp** | `inFlightCount > maxConcurrent` | `[]`, no throw |
| **capacity bounds: max-zero-boundary** | `maxConcurrent=0`, any `inFlightCount`, any items | `[]` |
| **ineligibility filters: missing ready:po** | Backlog item without `ready:po`, capacity available | Skipped |
| **ineligibility filters: wip:* label present** | Backlog item with e.g. `wip:architect` (and `ready:po`) | Skipped |
| **ineligibility filters: open blocker** | Backlog item with `[{state:"OPEN"}]` (and `ready:po`) | Skipped |
| **ineligibility filters: non-Backlog column** | Item in `"In Architecture"` with `ready:po` | Skipped |

Each test asserts the exact array shape (e.g. `[{ issueNumber: 1, to: "In Architecture" }]`) — not `toHaveLength`. The `to` field is part of the contract; assert it.

### What NOT to test

- Don't enumerate every `wip:*` suffix variant — `selection.test.ts` already covers the prefix-match invariant; we re-use the same predicate idiom and only need one positive `wip:*` case here.
- Don't test `hasOpenBlockers` edge cases (mixed states, etc.) — covered in `blockers.test.ts`.
- Don't add a "preserves input order" case as a separate `it` — the `both-advance-same-cycle` and `partial-in-flight-reduces-capacity` cases already assert order via the expected array.

## Concurrency model

None. Pure synchronous function. The caller (`src/loop/` in a future ticket) is responsible for serialising calls relative to GitHub-state reads.

## Error handling

No throws. Every input case (negative `maxConcurrent`, `inFlightCount > maxConcurrent`, empty `items`, malformed-but-typed `SelectionItem`) collapses to either an empty result or a clamped capacity walk. `parseCommitsAhead`-style "throw on garbage" doesn't apply: this module receives already-typed inputs from the caller's GitHub adapter.

## Open questions

None. The ticket body specifies the function signature, the eligibility predicate, the capacity formula, and the required test cases. No discretionary calls remain.

## Out of scope (do not implement here)

- Auto-advance for `In Architecture → In Development`, `In Development → In Code Review`, etc. — follow-up slices.
- The system-level test that exercises `selectDispatches` and `decideAutoAdvance` together through a binding-cap scenario — lives with the consumer ticket.
- Any wiring into `src/loop/` or `src/dispatch/` — call sites are added by their respective tickets.
- Adding `decideAutoAdvance` to a barrel/re-export — CLAUDE.md forbids internal barrel imports.

## Definition of done

- `src/pipeline/auto-advance.ts` exists, exports `decideAutoAdvance`, `AutoAdvanceState`, `AdvanceDecision`. ≤60 lines of production code (target ~30).
- `test/pipeline/auto-advance.test.ts` exists with the nine cases above. All green.
- `pnpm typecheck && pnpm test` clean.
- No `await`, no `gh` / `git` / `fs` calls (`rg -n 'await|child_process|fs/promises|gh ' src/pipeline/auto-advance.ts` must return zero hits).
- No edits to `src/pipeline/selection.ts`, `src/pipeline/blockers.ts`, `src/pipeline/transitions.ts`. Read-only consumers.
- Spec file committed alongside the implementation.
