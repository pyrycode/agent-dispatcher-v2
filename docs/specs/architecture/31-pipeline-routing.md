# Architecture spec — `src/pipeline/routing.ts`

Ticket: [#31](https://github.com/pyrycode/agent-dispatcher-v2/issues/31). Size: **XS**.

## Files to read first

- `src/pipeline/transitions.ts:42-57` — the `Label` union and `LabelPattern` type. The `needs-rework:*` members of `Label` are the exhaustive set of rework targets; `Agent` derives from them.
- `src/pipeline/decisions.ts:30-50` — sibling pure-function shape (POJOs in, decision out, no I/O). Mirror this style.
- `src/pipeline/blockers.ts:16-22` — `BranchState` uses `readonly string[]` for labels. Same idiom applies here: `decideReworkRouting` accepts arbitrary GitHub labels (not just the narrow `Label` union) because `wip:*` and `error:*` are GitHub state, not transition triggers.
- `src/pipeline/sizing.ts:1-41` — pure-file header style + named constants pattern. Match the comment density.
- `test/pipeline/decisions.test.ts:120-172` — table-driven test pattern with structural-gap and invariant assertions. Routing tests follow the same shape, scaled to a smaller table.
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — hard rule for this file: no `await`, no `gh` / `git` / `fs`.

## Context

Rework routing is the second of two pure-function modules under `src/pipeline/` (alongside `decisions.ts` from #5). When a reviewing agent flags `needs-rework:<target>`, the dispatcher loop needs to know:

1. **Which agent gets re-run** — read off the `needs-rework:*` label.
2. **Which stale state to strip** — `ready:*`, `wip:*`, `error:*` labels from the prior run, so the target agent runs on a clean slate.

Mirrors v1's `runReworkRouting` strip contract. Note: `decideLabelDelta` (#5) already strips `ready:*` and `needs-rework:*` per the transitions table, but it does **not** touch `wip:*` / `error:*` (these aren't transition triggers — they're dispatcher run-state). Rework routing is the only place that surfaces them, which is why this is a separate function.

The `needs-rework:<target>` label itself is **not** in `stripLabels` — the dispatcher's promotion step downstream consumes it when flipping the ticket to `wip:<target>`. Stripping it here would race against that promotion.

## Design

### File layout

- **New:** `src/pipeline/routing.ts` (~20 lines production).
- **New:** `test/pipeline/routing.test.ts`.
- No other files touched.

### Public surface

```ts
// src/pipeline/routing.ts

import { type Label } from "./transitions.ts";

// Derived from Label so adding a needs-rework target in transitions.ts
// surfaces in Agent automatically — single source of truth.
//
// Yields "po" | "architect" | "developer" | "code-review" today.
type ExtractAgent<L> = L extends `needs-rework:${infer A}` ? A : never;
export type Agent = ExtractAgent<Label>;

export interface ReworkRouting {
  readonly target: Agent | null;
  readonly stripLabels: readonly string[];
}

export function decideReworkRouting(labels: readonly string[]): ReworkRouting;
```

**Input shape rationale.** `labels` is `readonly string[]`, not `readonly Label[]`, because `wip:*` and `error:*` are intentionally absent from the narrow `Label` union (per `transitions.ts:38-41`). This function is the boundary where dispatcher state crosses a pure predicate; widening `Label` to admit `wip:*`/`error:*` would break the dead-letter invariant in `decideLabelDelta`'s tests.

**`Agent` derivation rationale.** The PO body says `Agent` "comes from `transitions.ts`" — strictly speaking it doesn't exist there, but it's structurally implied by the `needs-rework:*` members of `Label`. Deriving `Agent` via template-literal `infer` keeps the single source of truth on `Label` and means a future ticket that adds (e.g.) `needs-rework:documentation` to `Label` widens `Agent` automatically — no second site to update.

### Algorithm

1. Find the first label matching `needs-rework:<x>` where `<x>` is non-empty.
   - If none, return `{ target: null, stripLabels: [] }` immediately. (No rework — caller's no-op.)
   - If one is found, capture `<x>` as `target`. Cast through `Agent`; runtime validity is structurally guaranteed because the only producers of `needs-rework:*` labels are the agent labels in `Label`. Defensive validation against the `Agent` literal set is not warranted (CLAUDE.md § "Don't write a defense for a failure mode that hasn't been observed").
2. Compute `stripLabels` = every label in `labels` whose name starts with `ready:`, `wip:`, or `error:`.
   - Do **not** include the `needs-rework:<target>` label itself, even though it begins with a strip-eligible-looking prefix; the dispatcher consumes it downstream when promoting to `wip:<target>`.
   - Preserve input order; do not dedupe (caller is responsible for the GitHub label API contract).
3. Return `{ target, stripLabels }`.

### Concurrency

None — synchronous pure function. No goroutines, no channels (TS, but the analogue: no `Promise`, no async).

### Error handling

The function does not throw. Pre-conditions are trivially satisfied by any `string[]`. Two edge cases worth naming explicitly so the test suite covers them:

- **Multiple `needs-rework:*` labels present.** Pick the first by `labels` order. The dispatcher already maintains the invariant `≤1 needs-rework:*` per ticket via `decideLabelDelta`'s strips; this function does not re-validate it. Tests assert the deterministic-first-wins behaviour so future drift is caught.
- **Malformed label like bare `needs-rework:`** (empty target). Treat as not-a-rework-label: `target` stays `null` and we keep scanning. Justification: the only producers of `needs-rework:*` are the closed `Label` union, which has no empty-suffix member; a malformed label on a real ticket is a manual-edit accident, and silently ignoring it routes the ticket through the no-op path rather than crashing the loop.

## Testing strategy

`test/pipeline/routing.test.ts` — table-driven, mirroring `decisions.test.ts`.

**Required cases (one assertion per acceptance criterion, plus invariants):**

1. **No `needs-rework:*` label** → `{ target: null, stripLabels: [] }`. Cover with `[]`, `["size:s"]`, and `["ready:po", "wip:architect"]` (the latter proves we don't pre-emptively strip without a rework trigger).
2. **Each of the four `needs-rework:<target>` values** routes to that `target`. One case per agent: `po`, `architect`, `developer`, `code-review`.
3. **`stripLabels` includes every `ready:*`, `wip:*`, `error:*` label.** Input: `["ready:architect", "wip:developer", "error:max-turns", "needs-rework:architect", "size:s", "priority:high"]`. Expect `target: "architect"`, `stripLabels: ["ready:architect", "wip:developer", "error:max-turns"]`.
4. **`stripLabels` does NOT include `needs-rework:<target>`.** Same fixture as (3) — assert `expect(stripLabels).not.toContain("needs-rework:architect")`.
5. **Non-matching labels survive.** Same fixture — assert `size:s`, `priority:high`, `security-sensitive` are NOT in `stripLabels`.
6. **Multiple `needs-rework:*` — first wins.** Input: `["needs-rework:developer", "needs-rework:architect"]` → `target: "developer"`. (Asserts deterministic ordering, even though the dispatcher's normal-path invariant prevents this configuration.)
7. **Malformed `needs-rework:` (empty suffix)** → `target: null`. Input: `["needs-rework:"]` → `{ target: null, stripLabels: [] }`.

**Structural invariant test:** for every `Label` member matching `needs-rework:*` (iterate the closed set hard-coded in the test — TS literal types erase at runtime, so list them: `["needs-rework:po", "needs-rework:architect", "needs-rework:developer", "needs-rework:code-review"]`), `decideReworkRouting([label]).target` must be a non-null string equal to the suffix. This catches a future addition to `Label` that lacks a routing-test entry — the invariant fails the suite if `Agent`'s derived literal set drifts from this list. Comment the test referencing `transitions.ts:42-51` so the next contributor knows where to mirror the change.

## Open questions

None. The acceptance criteria are exhaustive and the v1 strip contract is well-specified.
