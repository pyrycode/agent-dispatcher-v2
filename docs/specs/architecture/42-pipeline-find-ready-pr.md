# Architecture spec — #42 `src/pipeline/find-ready-pr.ts`

A single pure predicate, `findReadyPrNumber(prs): number | null`, that
classifies a list of PR candidates and picks the lowest-numbered ready one
(or `null` if none qualify). "Ready" means: not a draft AND no label
matching the `error:*` global-block prefix. Lives in `src/pipeline/` per
CLAUDE.md ("Pure functions in `src/pipeline/`, I/O at the edges"); the PR
shapes come in as POJOs from a future `src/github/` list-query, the lowest
qualifying number goes out.

## Files to read first

The developer's turn-1 reading list. Each entry has a one-line "what to extract."

- `src/pipeline/selection.ts:38-49` — `SelectionItem` shape: narrow input type defined alongside the predicate, `readonly string[]` labels, `readonly` everywhere. **Mirror this layout** for `ReadyPrCandidate`.
- `src/pipeline/selection.ts:81-89` — `isEligible` + `hasWipLabel` shape: `prefix-startsWith` filter helper, structural per-item scoping, no exported helper until a second consumer appears. **Mirror this** for the draft + `error:*` filter pair.
- `src/pipeline/blockers.ts:9-26` — POJO input + `hasOpenBlockers` style: predicate over `readonly` array, no defensive `?? []`, no throws on a typed input. Same posture here.
- `src/github/pr.ts:26-30` — `PrInfo` type. **Type-only import** (AC #1: `import type { PrInfo } from "../github/pr.ts"`). `ReadyPrCandidate extends PrInfo` adds the two fields the predicate needs (`isDraft`, `labels`); the future list-PRs function is then free to return a structural superset of `PrInfo` without breaking this seam.
- `test/pipeline/selection.test.ts:9-11` — `mkState` test helper pattern + inline POJO literals. **Mirror this** for `mkPr` if any boilerplate emerges; defer the helper until 4+ fields per row.
- `test/pipeline/blockers.test.ts:9-29` — `describe`-per-export, `it`-per-row, prefix-vs-substring regression row (`something-wip:bar` does NOT trigger). The `error:*` prefix gets the same regression row.
- `docs/PROJECT-MEMORY.md` § "src/pipeline/ purity (#6)" — narrow types in-file, helpers stay unexported, set-intersection predicates use exact string equality. § "src/pipeline/ selection (#30)" — prefix-match (`startsWith`), per-item structural scoping, no defensive widening.
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — no `await`, no `gh`/`git`/`fs`/`process.env`, no imports from `src/github/`/`src/claude/`/`src/worktree/`/`src/salvage/`/`src/index.ts` (AC #1 enumerates the exact ban list). § "Test-first" — RED → GREEN → REFACTOR. § "Don't write a defense for a failure mode that hasn't been observed" — no runtime validation against the input type.
- `biome.json:5-19` — double quotes, trailing commas all, semicolons always, 100-col, 2-space indent. The new file MUST land in this style or `pnpm lint` fails.

The ticket body itself enumerates the 5 acceptance criteria — re-read them
against the test list in § Testing strategy below; each AC must map to ≥1
`it`.

## Context

**Why now.** Two consumers want a "is this PR ready to merge" classifier:

1. **Loop's `runAutoMerge`.** When `findReadyPrNumber` returns a number, the
   loop hands it to `mergePr` (#41). When `null`, the cycle skips PR
   processing for this issue. Both PR-list shape and merge primitive land
   in `src/github/`; this predicate sits in between, pure.
2. **Predicate-completeness audit (2026-05-03).** The draft-filter rule is
   the v1 lesson outcome: a draft PR carrying `ready:code-review` was
   selected for auto-merge because the prior code keyed on labels alone.
   The fix is the second filter row, not a one-off carve-out — every
   PR-shape variant the predicate distinguishes must have a row in the
   test matrix. Ticket body's AC #5 mandates the audit comment.

The two filter rules are independent — a PR can be (draft × error-labeled),
(draft × not-error), (not-draft × error-labeled), or (not-draft × not-error).
Only the last cell is "ready." That 2×2 grid IS the predicate-completeness
audit; future rules add a dimension, not a special case.

**What this is not.** This module:

- Does NOT fetch PRs. The list-PRs query is `src/github/`'s concern (a
  future ticket — not #41, which only owns mutation primitives).
- Does NOT mutate labels, statuses, or the project board. Decision-only.
- Does NOT decide whether to merge a "ready" PR — `mergePr` (#41) does
  that. This predicate just picks the candidate.
- Does NOT deduplicate, validate, or normalize the input array. Caller
  owns the contract; TypeScript types are the boundary.

## Design

### File: `src/pipeline/find-ready-pr.ts`

Single new file. Estimated 20–30 production lines, deeply under the
200-line hardcap. Imports `PrInfo` (type-only) from `../github/pr.ts`.

#### Module shape

```ts
// src/pipeline/find-ready-pr.ts

import type { PrInfo } from "../github/pr.ts";

// Narrow input shape. Extends PrInfo with the two fields the predicate
// reads (the upstream list-PRs query in src/github/ will return a
// structural superset of PrInfo; this seam stays type-anchored to that
// module without importing any function from it). Per the #6 narrow-types
// rule, do NOT widen for hypothetical future consumers (e.g. createdAt,
// author). Add when an observed predicate needs the field.
export interface ReadyPrCandidate extends PrInfo {
  readonly isDraft: boolean;
  readonly labels: readonly string[];
}

const ERROR_LABEL_PREFIX = "error:";

export function findReadyPrNumber(prs: readonly ReadyPrCandidate[]): number | null {
  let lowest: number | null = null;
  for (const pr of prs) {
    if (pr.isDraft) continue;
    if (hasErrorLabel(pr.labels)) continue;
    if (lowest === null || pr.number < lowest) {
      lowest = pr.number;
    }
  }
  return lowest;
}

function hasErrorLabel(labels: readonly string[]): boolean {
  return labels.some((l) => l.startsWith(ERROR_LABEL_PREFIX));
}
```

That's the entire production surface. One exported type, one exported
function, one unexported helper, one unexported constant.

#### Why `ReadyPrCandidate extends PrInfo`

The AC says "The `PrInfo` type is imported type-only from `src/github/pr.ts`;
no functions imported from there." `PrInfo` today is `{ number, nodeId, url }`
— it does NOT carry `isDraft` or `labels` (#41 deliberately kept it narrow
because the methods that produce a `PrInfo` — `createPr`'s response — don't
have draft state). Three options were considered:

1. **Define a fully local input type** (`{ number, isDraft, labels }`),
   no import from `pr.ts`. The AC's literal reading still allows this
   ("type-only IF imported"), but it disconnects this module's input shape
   from the future list-PRs query's output shape. The list query will
   return rows with `nodeId` and `url` for downstream consumers (`mergePr`
   takes a number; `enableAutoMerge` could take either). The list-PRs
   author then has to either invent a separate shape or convince this
   module's input to widen. Wasted seam.
2. **Widen `PrInfo`** in `pr.ts` to include `isDraft` + `labels`. Cross-ticket
   change to a landed module, drags out of scope, and the createPr response
   path doesn't naturally carry those fields. Wrong side.
3. **`extends PrInfo` here** — additive, type-only, anchors the input
   shape to the future list-PRs query's output via TypeScript's structural
   subtyping. The list query returns `ReadyPrCandidate[]` (or a wider
   superset of it) and this predicate consumes it without further work.

Option 3 is the cheap, correct seam. Test fixtures pass full `PrInfo` shape
(stub `nodeId: "MDEx..."`, stub `url: "https://..."`) plus `isDraft` + `labels`.

#### Determinism — lowest PR number wins

When multiple PRs survive both filters, the predicate picks **deterministically
by PR number, lowest wins.** The single-pass loop tracks `lowest` rather than
sorting. Two reasons:

- Sorting is a no-op on the typical input (one or two candidates per cycle);
  single-pass min-tracking is the same code-shape as the existing pipeline
  predicates (see `selectDispatches`'s early-`break` / `result.push` shape).
- Input ordering does NOT affect output. The test matrix pins this with a
  reverse-order assertion: feeding `[#3, #2, #1]` yields `1`, identical
  to `[#1, #2, #3]`.

"Lowest PR number" is a stable order across cycles — GitHub PR numbers
monotonically increase, so "lowest" means "oldest open ready PR." Matches
v1's "older first" tiebreak in selection.ts § Open question 3.

#### Imports

`import type { PrInfo } from "../github/pr.ts";` is the only import. Note:

- **Type-only**, not a value import. AC #1 explicitly bans function imports
  from that file. `import type` is erased at compile time so no runtime
  edge crosses the I/O boundary.
- **Sibling-directory import is forbidden** by AC #1's enumeration: no
  imports from `src/github/`, `src/claude/`, `src/worktree/`, `src/salvage/`,
  or `src/index.ts`. The `import type` exception is narrow and explicit
  here (the AC names `PrInfo` as the one allowed crossing).
- Same intra-pipeline sibling pattern as `selection.ts`: imports from
  `./blockers.ts` and `./transitions.ts` work because they are pure-pipeline
  siblings. This module's internal needs are minimal — no `Blocker`, no
  `Column`, no rework label set — so it pulls only `PrInfo`.

### Concurrency model

None. Pure synchronous function over a POJO array, no shared state, no
I/O. The whole point of `src/pipeline/`.

### Error handling

- `findReadyPrNumber` cannot throw on any input that satisfies its
  TypeScript type. Empty input returns `null`.
- We do NOT defensively `?? []` on `pr.labels`. The TypeScript type is
  the contract; if a caller passes `undefined`, that is a caller bug at
  the I/O boundary (same stance as `blockers.ts` and `selection.ts`).
- We do NOT validate that `pr.number > 0` or that `pr.isDraft` is a
  boolean. CLAUDE.md "Don't write a defense for a failure mode that
  hasn't been observed."
- We do NOT throw on duplicate PR numbers or on a `PrInfo` with `nodeId: ""`
  / `url: ""`. The predicate reads only `number`, `isDraft`, `labels`; the
  other fields are caller-supplied passthrough that this module never
  inspects. Same reasoning as `selectDispatches` not validating `column`.

### Testing strategy

`test/pipeline/find-ready-pr.test.ts` mirrors the source path. Vitest,
RED-first (CLAUDE.md mandate). Each AC bullet maps to assertions; rows
are organized so the predicate-completeness audit is one cohesive `describe`
block.

#### Predicate-completeness audit comment

Top of the test file (after imports), as a multi-line comment listing the
2×2 variant grid:

```ts
// Predicate-completeness audit — every PR-shape variant findReadyPrNumber
// distinguishes must have a row in the matrix below. Adding a future
// filter rule = adding a dimension, not a special case.
//
//   isDraft  errorLabeled   → ready?         covered by
//   ─────────────────────────────────────────────────────
//   true     true           → no              row A
//   true     false          → no              row B
//   false    true           → no              row C
//   false    false          → YES             row D
//
// Each row below carries an `// audit: row X` tag so a regression points
// at the exact failing variant.
```

The four rows IDed by tag (`row A` / `row B` / `row C` / `row D`) appear
in `describe("findReadyPrNumber — predicate-completeness 2×2 grid")` with
one `it` each. AC #5 is satisfied by this comment + four assertions.

#### `describe("findReadyPrNumber — empty / null cases")` — AC #4 first row

- empty input array → `null`
- input with one draft PR (no error labels) → `null`
- input with one ready-but-error-labeled PR → `null`

#### `describe("findReadyPrNumber — predicate-completeness 2×2 grid")` — AC #5

- row A: one PR, `isDraft: true`, `labels: ["error:max_turns_salvaged"]` → `null`
- row B: one PR, `isDraft: true`, `labels: []` → `null`
- row C: one PR, `isDraft: false`, `labels: ["error:max_turns_salvaged"]` → `null`
- row D: one PR, `isDraft: false`, `labels: []` → that PR's `number`

#### `describe("findReadyPrNumber — error:* prefix semantics")` — AC #2 second clause

- `labels: ["error:max_turns_salvaged"]` → filtered out
- `labels: ["error:merge-conflict"]` → filtered out (different suffix; prefix match)
- `labels: ["error:"]` → filtered out (bare prefix is still a match — closed semantics, defer the validate-suffix check until a real label collides)
- regression: `labels: ["something-error:foo"]` → NOT filtered (prefix match, not substring; mirrors `something-wip:bar` row in `selection.test.ts:117`)
- regression: `labels: ["ready:code-review"]` → NOT filtered (no `error:` prefix; baseline)

#### `describe("findReadyPrNumber — multi-PR selection")` — AC #3

- two ready PRs `[#5, #2]` (both `isDraft: false`, `labels: []`) → `2` (lowest wins)
- three ready PRs `[#10, #3, #7]` → `3`
- input order independence: `[#10, #3, #7]` and `[#7, #10, #3]` and `[#3, #7, #10]` all yield `3` (one `it` for each ordering, so a regression to "first-pass" or "last-pass" surfaces at the offending row)
- mixed: ready `#7`, draft `#1`, ready `#3`, error-labeled `#2` → `3` (the lowest *qualifying* number, NOT `1` or `2`)

#### `describe("findReadyPrNumber — drafts mixed with ready")` — AC #4 second/third rows

- one ready among drafts: `[draft #1, draft #2, ready #3]` → `3`
- ready-but-error-labeled mixed with drafts: `[draft #1, error-labeled-ready #2]` → `null` (no qualifying PR after both filters)

#### Test fixtures

Each test inlines its `ReadyPrCandidate[]` literal. A tiny `mkPr` helper
is acceptable if 4+ fields per row become repetitive (`nodeId` and `url`
are stub strings) — but per `selection.test.ts`'s precedent, defer the
helper until inlining is awkward. Suggested initial shape if needed:

```ts
function mkPr(
  number: number,
  isDraft: boolean,
  labels: readonly string[] = [],
): ReadyPrCandidate {
  return { number, nodeId: `node-${number}`, url: `https://example/${number}`, isDraft, labels };
}
```

`nodeId` and `url` are never read by the predicate, so the stubs are not
load-bearing — they exist to satisfy the `extends PrInfo` shape contract.

### Implementation order (RED → GREEN, per CLAUDE.md)

1. Create `test/pipeline/find-ready-pr.test.ts` with all assertions,
   importing from `../../src/pipeline/find-ready-pr.ts`. `pnpm test`
   fails (file does not exist). RED.
2. Create `src/pipeline/find-ready-pr.ts` with the type + function.
   `pnpm test` passes. GREEN.
3. `pnpm typecheck && pnpm lint` both pass.
4. Commit.

If you write the source first, discard and restart. CLAUDE.md is explicit:
"Backfilling tests after the fact ships bugs first."

### Files touched

- `src/pipeline/find-ready-pr.ts` — new, ~25 production lines
- `test/pipeline/find-ready-pr.test.ts` — new, ~80–110 lines (one `it`
  per row, plus the audit comment block)

No edits to existing files. No `src/index.ts` re-export (CLAUDE.md "Don't"
bullet).

The developer should also append a per-ticket implementation summary at
`docs/knowledge/codebase/42.md` (matching the precedent in the repo) and
add a "Patterns established" entry under a new `### src/pipeline/
find-ready-pr (#42)` heading in `docs/PROJECT-MEMORY.md`. Doc touch-ups,
not code.

## Open questions

1. **Bare `error:` label as a filter trigger.** Spec treats `labels: ["error:"]`
   as filtered out (prefix `startsWith` is permissive). The closed semantics
   match every other prefix-match predicate in the codebase
   (`hasWipLabel`, `hasNeedsReworkLabel`). If a future ticket introduces a
   real label that starts with `error:` but is NOT a global block (none
   exists today), this assumption breaks and the prefix becomes too
   broad. Recommendation: keep prefix-match; add an exclusion list at
   that point if it ever happens.

2. **PR-number tie-breaking.** GitHub PR numbers are unique within a
   repo, so no ties are possible in production input. The single-pass
   `< lowest` comparison is strict; `===` would never trigger. For
   synthetic test inputs the test sets unique numbers explicitly. If a
   future caller passes a multi-source aggregate where `number` collisions
   are possible, the first-seen value wins (because of strict `<`); add
   a tiebreak field at that point.

3. **`labels: []` vs `labels: undefined`.** Spec rejects `undefined`
   defensively (TypeScript types are the contract). If the upstream
   list-PRs query returns rows with `labels: undefined` (rather than
   empty arrays for unlabeled PRs), the I/O boundary normalizes — not
   this predicate. Same posture as `selectDispatches`.

4. **Empty `PrInfo` fields (`nodeId: ""` / `url: ""`).** Predicate doesn't
   read either; passthrough is unconditional. If a future caller wants
   "ready PR with valid nodeId," add the field check at that point — it
   is not this predicate's concern today.

## Out of scope (explicit non-goals)

- The list-PRs query in `src/github/`. Future ticket; this module's input
  type is the seam.
- Wiring this predicate into the loop. The loop module hasn't landed
  yet; this ticket lands one module.
- Per-agent / per-author filtering, age cutoffs, branch filters, base-branch
  filters. Add when an observed call site needs them.
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" bullet forbids it.
- Any change to `src/github/pr.ts` (notably: widening `PrInfo`). This
  ticket consumes the type; it does not modify it.
- `error:` suffix validation (e.g. enforcing the suffix is a known agent
  name). The closed `Label` union already excludes `error:*` from
  transition triggers (`transitions.ts:42-51`); a separate validator
  would duplicate that posture. Defer until observed.
