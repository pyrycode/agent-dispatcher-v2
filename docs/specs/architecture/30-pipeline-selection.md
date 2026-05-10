# Spec: `src/pipeline/selection.ts` — pure dispatch selector (#30)

## Files to read first

- `src/pipeline/blockers.ts` — exports `Blocker` and `hasOpenBlockers`. Both are reused verbatim by this module; do not redeclare either. Note that the `AgentName` defined here intentionally excludes `po` (it lists agents that produce commits, not agents that consume a column).
- `src/pipeline/transitions.ts:14-21` — `Column` union; the only type imported from this file. Do NOT import `TRANSITIONS` or `Label` — selection has no business with the transition table.
- `src/pipeline/sizing.ts` — closest pattern match: tiny pure module, multiple narrow exports, set-based eligibility predicate (`fileOverlapsAny`). Mirror this file's shape (top-of-file comment, narrow input types defined alongside the predicate, no internal helpers exported).
- `test/pipeline/sizing.test.ts` — vitest + import style (`../../src/pipeline/sizing.ts` with `.ts` extension preserved); shape of boundary-pinning tests; one `describe` per export, one `it` per row.
- `test/pipeline/blockers.test.ts:9-29` — confirms the `hasOpenBlockers` semantics this module relies on (only `state === "OPEN"` blocks; unknown states fail safe). The behaviour must not be re-tested here — that's blockers.ts's job.
- `docs/PROJECT-MEMORY.md` § "src/pipeline/ purity (#6)" — narrow types defined in-file, helpers stay unexported until a second consumer appears, set-intersection-style predicates use exact string equality.
- `CLAUDE.md` § "Pure functions in `src/pipeline/`" — no `await`, no `gh`/`git`/`fs` calls. § "The throughput equation is `min(...)` of every gate" — names this ticket's term explicitly. § "Don't" bullet on barrel imports.
- `biome.json:5-19` — double quotes, trailing commas all, semicolons always, 100-col, 2-space indent. The new file MUST land in this style or `pnpm lint` fails.

The ticket body itself enumerates the 8 acceptance criteria — re-read them against the test list in § Testing strategy below; each AC must map to ≥1 `it`.

## Context

This module lands the `selectDispatches.cap` term from CLAUDE.md's throughput equation:

```
actual_wip = min(
  selectDispatches.cap,    ← this ticket
  decideAutoAdvance.backlog_cap,
  blocker_chain,
  MANUAL_ADVANCE_GATES,
)
```

It's a pure, stateless decision over a snapshot of board state: "given these items and a capacity, which `(agent, item)` pairs should the dispatcher fire next cycle?" The whole `min(...)` of the throughput equation works only if every term is local and composable — that's why this term takes `maxConcurrent` as a parameter rather than reading a global constant.

Out of scope:
- The dispatcher loop that consumes these tuples (`src/loop/`, `src/dispatch/` — neither file exists yet).
- Any I/O — board fetch, label mutation, worktree creation. Those live behind the `src/github/` and `src/worktree/` boundaries; this module never sees them.
- The auto-advance / blocker-chain / manual-advance gates listed alongside in the equation — each is its own pipeline module, landed in its own ticket.
- Priority assignment. The caller hands items to this function in priority order (board-native ordering); the selector preserves that order. v1's "ties broken by issue number (older first)" tiebreak is the caller's responsibility — see Open question 3.

The ticket title says "selection half of `src/pipeline/`," but the right framing is narrower: this is **one term** of a `min(...)` equation. The function knows nothing about the other terms; the loop composes them.

## Design

### File: `src/pipeline/selection.ts`

Single new file. Estimated 50–70 production lines, well under the 200-line hardcap. Imports from `./blockers.ts` (`Blocker`, `hasOpenBlockers`) and `./transitions.ts` (`Column`) only.

#### The agent-key type — local, not extended

The ticket presents three options for the `AGENT_COLUMN_MAP` key type. **Decision: define `Agent` locally in `selection.ts`.**

```ts
export type Agent = "po" | "architect" | "developer" | "code-review" | "documentation";
```

Rationale:

- `AgentName` in `blockers.ts` is the closed set of agents whose runs are expected to produce commits (it gates `shouldProduceCommits`'s exhaustive switch). PO does not fit that set semantically — PO triages tickets and emits labels; whether a PO run produces commits is a separate question that the existing `shouldProduceCommits` predicate would have to answer with a `case "po": return false;` row. Adding that row to satisfy a different module's needs muddies what `AgentName` means.
- Per the narrow-types rule (PROJECT-MEMORY § "src/pipeline/ purity (#6)"), each pipeline module owns its narrow type for its narrow concern. Two parallel narrow types (`AgentName` for commit producers, `Agent` for column consumers) is *correct*, not duplication. They overlap by four members today; that overlap is incidental, not structural.
- A future ticket that genuinely needs both unions can promote a shared `Agent` (or rename one of the existing types) at that moment. Doing it now is widening for hypothetical future consumers, exactly the smell PROJECT-MEMORY § (#6) calls out.

The drawback (string drift between two type unions) is bounded: both files are < 100 lines, both are pure, and any test that exercises both modules together will surface a mismatch immediately.

#### `AGENT_COLUMN_MAP` — the public table

```ts
export const AGENT_COLUMN_MAP: Record<Agent, Column> = {
  po: "Backlog",
  architect: "In Architecture",
  developer: "In Development",
  "code-review": "In Code Review",
  documentation: "In Documentation",
};
```

Five entries. The mapping is derived from `TRANSITIONS` (Backlog → In Architecture requires `ready:po`, so PO consumes Backlog; etc.) but is **encoded as data here**, not derived at runtime. Why:

- The transition table's `requires` labels happen to align with column consumers today, but conflating "this label gates this transition" with "this agent consumes this column" couples two distinct concerns. A future label scheme change (e.g. `ready:po` becomes `triaged:po`) shouldn't ripple into selection.
- A pinning test (§ Testing strategy) anchors the five rows so any drift trips the test, not a downstream dispatch bug.

`Inbox` and `Done` are absent from this map. Inbox → Backlog is a manual human-triage move (see `transitions.ts:78`); Done is terminal. Items in either column have no consuming agent and are silently skipped by `selectDispatches`.

#### Input types — narrow, defined in-file

```ts
export interface SelectionItem {
  // Status column on the project board. Items in non-mapped columns
  // (Inbox, Done) are skipped — they have no consuming agent.
  column: Column;
  issueNumber: number;
  // GitHub label names on the issue. Caller (src/github/) maps the richer
  // label objects to a string array before handing off.
  labels: readonly string[];
  // Open / closed blockers attached to the issue. Reuses the Blocker
  // shape from blockers.ts — same narrow `{ state: string }` POJO.
  blockers: readonly Blocker[];
}

export interface SelectionState {
  items: readonly SelectionItem[];
}
```

`SelectionState` exists as a wrapper (rather than `selectDispatches(items, max)`) so a future ticket can extend the input shape (e.g. with rate-limit budget, per-agent caps) without changing the function signature in every call site. Today it has one field; that's fine — the wrapper is one extra `state.items` indirection, near-zero cost, and the alternative (renaming the parameter list later) is a much bigger refactor.

#### Output type — minimal

```ts
export interface DispatchTuple {
  readonly agent: Agent;
  readonly issueNumber: number;
}
```

The dispatcher only needs `(agent, issueNumber)` to act — it builds the worktree from the issue number and fans the agent out from there. Returning the full `SelectionItem` would widen the contract for hypothetical future consumers; per the narrow-types rule, don't. If a downstream caller needs more, it has the original `state.items` array in scope and can re-look-up.

#### `selectDispatches(state, maxConcurrent): DispatchTuple[]`

```ts
export function selectDispatches(
  state: SelectionState,
  maxConcurrent: number,
): DispatchTuple[] {
  if (maxConcurrent <= 0) return [];
  const result: DispatchTuple[] = [];
  for (const item of state.items) {
    if (result.length >= maxConcurrent) break;
    if (!isEligible(item)) continue;
    const agent = COLUMN_TO_AGENT[item.column];
    if (!agent) continue;
    result.push({ agent, issueNumber: item.issueNumber });
  }
  return result;
}
```

Algorithm in three lines: walk items in input order, skip ineligible / non-consumed-column items, stop at the cap. Capacity is exact — the early `break` makes the bound explicit. `maxConcurrent <= 0` short-circuits to handle both 0 and pathological negative inputs (latter is a contract violation; we choose to no-op rather than throw, matching v1's permissive shape).

Per-issue label scoping is a structural property of the loop body: each iteration reads only `item.labels` and `item.blockers`. Item B's labels are physically out of scope when deciding item A. The label-scoping AC is verified by a test that puts a `wip:*` on item A and asserts item B is still selected — see § Testing strategy.

#### Internal helpers — unexported

```ts
const COLUMN_TO_AGENT: Partial<Record<Column, Agent>> = (() => {
  const out: Partial<Record<Column, Agent>> = {};
  for (const [agent, col] of Object.entries(AGENT_COLUMN_MAP) as [Agent, Column][]) {
    out[col] = agent;
  }
  return out;
})();

function isEligible(item: SelectionItem): boolean {
  if (hasWipLabel(item.labels)) return false;
  if (hasOpenBlockers(item.blockers)) return false;
  return true;
}

function hasWipLabel(labels: readonly string[]): boolean {
  return labels.some((l) => l.startsWith("wip:"));
}
```

Three internal helpers, none exported. Per PROJECT-MEMORY § (#6), helpers stay unexported until a second consumer appears.

`COLUMN_TO_AGENT` is the reverse of `AGENT_COLUMN_MAP`, derived at module load. We could write both as data, but deriving keeps the public table the single source of truth — a future change to `AGENT_COLUMN_MAP` cannot drift from the reverse map. The IIFE is the boilerplate cost; ~6 lines.

`hasWipLabel` mirrors `hasNeedsReworkLabel` in `blockers.ts`: prefix match, not substring. The label `something-wip:bar` does NOT trigger the gate (and this is regression-tested) — only labels whose name starts with `wip:`.

`isEligible` is the one place the gates compose. Adding a future gate means adding a line here; the function name stays accurate. **Important:** when (eventually) a third pipeline gate appears that wants to ask "is this item dispatchable?", do not export `isEligible` preemptively — the third consumer is itself a hypothetical until observed.

### Concurrency model

None. Pure synchronous functions over POJOs, no shared state, no I/O. The whole point of `src/pipeline/`.

### Error handling

- `selectDispatches` cannot throw on any input that satisfies its TypeScript type. `maxConcurrent <= 0` short-circuits to `[]`; `state.items` is iterated as-is.
- We do NOT defensively `?? []` on `item.labels` or `item.blockers`. The TypeScript types are the contract; if a caller passes `undefined`, that is a caller bug at the I/O boundary (same stance as `blockers.ts`).
- We do NOT throw on items in unmapped columns (Inbox, Done). Silent skip is correct: a board with un-statused items or items mid-transition shouldn't deadlock the loop.

### Testing strategy

`test/pipeline/selection.test.ts` mirrors the source path. Vitest, RED-first (CLAUDE.md mandate). Each AC bullet maps to a `describe` block; each row is one `it`.

#### `describe("AGENT_COLUMN_MAP")` — one per row plus a size pin

Five rows, asserted directly on the constant. Plus one `Object.keys(AGENT_COLUMN_MAP).length === 5` assertion as the size pin (so a future "while I'm here" addition trips a test). Maps to AC #1.

#### `describe("selectDispatches — capacity bounds")` — AC #3

- empty `state.items` → `[]`
- `maxConcurrent: 0` with non-empty items → `[]`
- 3 eligible items, `maxConcurrent: 1` → 1 result
- 3 eligible items, `maxConcurrent: 3` → 3 results
- 3 eligible items, `maxConcurrent: 5` → 3 results (beyond-N case)
- input order is preserved (3 items, returned `issueNumber`s in input order)

#### `describe("selectDispatches — wip-gate exclusion")` — AC #4

- item with `wip:architect` label is excluded
- item with `wip:foo` (any wip:* prefix, even unknown agent) is excluded
- prefix match, not substring: `something-wip:bar` does NOT exclude (regression guard, mirrors the `something-needs-rework:po` test in `blockers.test.ts:82`)

#### `describe("selectDispatches — blocker-gate exclusion")` — AC #5

- item with one `{ state: "OPEN" }` blocker is excluded
- same item with `{ state: "CLOSED" }` instead is included
- mixed `[{ state: "OPEN" }, { state: "CLOSED" }]` is excluded
- empty `blockers: []` is included
- delegates to `hasOpenBlockers` — don't re-test its full matrix here; one OPEN-and-one-CLOSED case is sufficient to prove the integration.

#### `describe("selectDispatches — per-issue label scoping")` — AC #6

- two items, A has `wip:architect`, B has no labels: result contains B's tuple but not A's. The exact assertion is on A's absence AND B's presence — proves labels don't bleed in either direction.
- two items, A has an OPEN blocker, B has none: result contains B's tuple but not A's.

#### `describe("selectDispatches — column → agent mapping")`

- one item per consuming column (Backlog, In Architecture, In Development, In Code Review, In Documentation), `maxConcurrent: 5` → asserts the exact `(agent, issueNumber)` tuple for each.
- items in Inbox or Done → silently skipped (result excludes them).

#### Test fixtures

Each test inlines its `SelectionState` literal. No shared helpers beyond a tiny `mkItem(partial)` if the boilerplate gets repetitive — but per `blockers.test.ts`, inlining 1–3-field POJOs is preferred for readability. Defer the helper until a test goes past 4 fields.

### Implementation order (RED → GREEN, per CLAUDE.md)

1. Create `test/pipeline/selection.test.ts` with all assertions, importing from `../../src/pipeline/selection.ts`. `pnpm test` fails (file does not exist). RED.
2. Create `src/pipeline/selection.ts` with types + exports. `pnpm test` passes. GREEN.
3. `pnpm typecheck && pnpm lint` both pass.
4. Commit.

If you write the source first, discard and restart. CLAUDE.md is explicit: "Backfilling tests after the fact ships bugs first."

### Files touched

- `src/pipeline/selection.ts` — new, ~50-70 production lines
- `test/pipeline/selection.test.ts` — new, ~120-160 lines (one `it` per row)

No edits to existing files. No `src/index.ts` re-export (CLAUDE.md "Don't" bullet).

The developer should also append a per-ticket implementation summary at `docs/knowledge/codebase/30.md` (matching the precedent in the repo) and add a "Patterns established" entry under a new `### src/pipeline/ selection (#30)` heading in `docs/PROJECT-MEMORY.md`. Doc touch-ups, not code.

## Open questions

1. **`Agent` type — local vs `AgentName` vs shared.** Spec recommends local. If the implementer believes a shared union is imminent (e.g. they're already eyeing a future ticket that needs both `shouldProduceCommits` and `AGENT_COLUMN_MAP`), promoting to a shared type now is defensible. Either choice is internally consistent. Recommendation: keep local; promote when the third caller appears.

2. **`DispatchTuple` shape — minimal `{ agent, issueNumber }` vs full `{ agent, item }`.** Spec recommends minimal. The dispatcher loop hasn't landed yet; we're designing for the *known* surface. If the loop ticket reveals it needs `column` or `labels` on the tuple, widen at that point — TypeScript will route the change to every test.

3. **Tie-breaking by issue number.** The ticket's technical note cites v1's "ties broken by issue number (older first)" behaviour. Spec defers this to the caller — the caller hands `state.items` in priority order, and on a real Projects v2 board there are no ties (board position is total). For synthetic test inputs, the test sets the order explicitly. If a future caller passes a multi-source aggregate where ties are real, add a stable secondary sort here (`items.toSorted((a, b) => a.issueNumber - b.issueNumber)` before the loop) and add a tiebreak test row.

4. **`SelectionState` wrapper vs `selectDispatches(items, max)`.** Spec keeps the wrapper. One field today; cheap; future-friendly (rate-limit budget, per-agent caps). The cost is one `state.items` indirection at every call site. Acceptable.

## Out of scope (explicit non-goals)

- `src/dispatch/` or `src/loop/` consumer wiring — no consumer module exists yet.
- Per-agent capacity caps (e.g. "max 1 architect concurrent"). Today the cap is a single global `maxConcurrent`; per-agent caps would be a new field on `SelectionState` or a per-call argument. Add when observed.
- Rate-limit / budget tracking. Lives at the loop boundary (PROJECT-MEMORY § (#19)).
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" bullet forbids it.
- Any change to `transitions.ts` or `blockers.ts`. This ticket consumes both; it does not modify either.
