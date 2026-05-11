# Spec: `src/pipeline/decisions.ts` — `decideLabelDelta` (#5)

## Files to read first

- `CLAUDE.md` § "`decideLabelDelta` is the only place labels mutate" — names this function as the *single* label-mutation site that pre-dispatch, post-run, rework routing, and done-cleanup all funnel through. The contract this ticket establishes.
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — no `await`, no `gh` / `git` / `fs`. POJOs in, decisions out.
- `CLAUDE.md` § "Test-first" — RED → GREEN → REFACTOR. Failing test in `test/pipeline/decisions.test.ts` first, implementation after.
- `CLAUDE.md` § "Don't" — bullet "Don't import from a barrel file (`src/index.ts`) inside `src/`"; bullet "Don't write a defense for a failure mode that hasn't been observed" (the `Label` and `LabelPattern` unions stay narrow — see #24's spec).
- `src/pipeline/transitions.ts:1-178` — the entire file. `Column`, `Label`, `LabelPattern`, `Transition`, `COLUMNS`, `TRANSITIONS` (19 rows: 6 forward + 13 rework). All five symbols this ticket consumes are exported here; nothing else needs to be defined to back this function.
- `src/pipeline/blockers.ts:1-7` — header-comment style and "POJO inputs / pure outputs" framing for the directory; new file mirrors it.
- `src/pipeline/blockers.ts:62-64` — `hasNeedsReworkLabel` shows the established `startsWith("needs-rework:")` prefix-matching idiom this function reuses (with the `LabelPattern` trailing `*` stripped).
- `docs/specs/architecture/24-pipeline-transitions.md:144-152` — the rework-row shape rationale (no `needs-rework:documentation`; same-column rework rows are legal; `wip:*` / `error:*` deliberately absent from `strips`). This function inherits all three constraints by construction.
- `docs/PROJECT-MEMORY.md` § "src/pipeline/ purity (#6)" and § "Transition table (#24)" — the two patterns sections this ticket extends without duplicating.
- `docs/lessons.md` § (skim) — gotchas accumulated; nothing new on label-delta semantics, but read to confirm.
- `biome.json:5-19` — formatter rules (double quotes, trailing commas all, semicolons always, 100-col width, 2-space indent). Lines over 100 cols break `pnpm lint`.
- `test/pipeline/blockers.test.ts:1-20` — vitest import shape (`import { describe, expect, it } from "vitest"`, `from "../../src/pipeline/<name>.ts"`).

## Context

#24 landed the transition table as data. This ticket lands the lookup function that turns one row into a `{ add, remove }` label delta. CLAUDE.md is unambiguous: "If you need to add a new label-mutation site, you're doing something wrong — the existing four cover the universe of state transitions." That guarantee holds *only* when every label-mutation site reads from this function — which means this function must encode no rule logic of its own. The `strips` patterns in the transition row plus the after-state's labels are the only inputs to the delta computation. before-state labels are just the comparison baseline ("what's actually present that the strip pattern would consume").

Out of scope: any consumer. Pre-dispatch (`src/dispatch/`), post-run cleanup (`src/loop/`), rework routing (`src/pipeline/decisions.ts` will gain a sibling `decideReworkRouting` in #7), done-cleanup — each is its own ticket. This ticket lands the lookup function and its per-row tests, nothing more.

The AC's "16 rows today" line predates the table actually landing — `TRANSITIONS` carries 19 rows (6 forward + 13 rework). The per-row test iterates `TRANSITIONS` rather than hard-coding a count, so the discrepancy is self-correcting; see Open questions §1.

## Design

### File: `src/pipeline/decisions.ts`

Single new file. One exported function, two exported input/output interfaces, no helpers (or one tiny private helper if the strip-prefix slice reads more clearly that way). Estimated 50–80 production lines; well under the 200-line hardcap and the 100-line AC ceiling.

#### Type definitions

Both interfaces are local to `decisions.ts`. Per CLAUDE.md "no barrels inside `src/`", do not re-export from `src/index.ts`. Future call sites (`src/dispatch/`, `src/loop/`) import directly from `./pipeline/decisions.ts`.

```ts
// State of a ticket at one end of a transition: which board column it's in
// and which transition-trigger labels it carries. `Label` is the closed
// union from transitions.ts — narrow on purpose. wip:*, error:*, size:*,
// priority:*, security-sensitive are dispatcher-run lifecycle / metadata,
// not transition triggers, and stay out until a transition actually
// consumes one (see #24 spec § "Notes on rework-row shape").
export interface TransitionState {
  readonly column: Column;
  readonly labels: readonly Label[];
}

// Delta the caller applies via the GitHub label API. `add` are labels to
// add to the ticket; `remove` are labels to remove. Both arrays are
// subsets of, respectively, `after.labels` and `before.labels` — the
// function never synthesizes a label out of thin air (see invariant test).
export interface LabelDelta {
  readonly add: readonly Label[];
  readonly remove: readonly Label[];
}
```

`labels: readonly Label[]` (not `Set<Label>`) matches the GitHub Projects v2 client's `ProjectItem.labels` shape (`#19`'s `string[]`). The function treats the arrays as sets — caller supplies de-duplicated lists; the function does not de-duplicate defensively (caller-trust at the boundary, per #6's narrow-types convention).

#### Function: `decideLabelDelta`

```ts
export function decideLabelDelta(
  before: TransitionState,
  after: TransitionState,
): LabelDelta {
  const row = TRANSITIONS.find(
    (t) => t.from === before.column && t.to === after.column,
  );
  if (!row) {
    throw new Error(
      `decideLabelDelta: no legal transition from "${before.column}" to "${after.column}"`,
    );
  }

  const stripPrefixes = row.strips.map((p) => p.slice(0, -1)); // drop trailing "*"
  const beforeSet = new Set<string>(before.labels);
  const afterSet = new Set<string>(after.labels);

  const remove = before.labels.filter(
    (l) => !afterSet.has(l) && stripPrefixes.some((px) => l.startsWith(px)),
  );
  const add = after.labels.filter((l) => !beforeSet.has(l));

  return { add, remove };
}
```

**Algorithm (rule-by-rule):**

1. **Look up the row.** `TRANSITIONS.find` over the (`from`, `to`) pair. Linear scan is fine — 19 rows; no profiler will care.
2. **Throw on no match.** Error message includes both column names verbatim so call sites can attribute the failure (and test the throw via a regex match).
3. **Compute `remove`.** A label is in `remove` iff (a) it's in `before.labels`, (b) it's NOT in `after.labels` (the caller still wants it; don't fight them), and (c) its name starts with one of `row.strips`'s prefixes (the trailing `*` stripped). The `(b)` clause is what makes forward auto-advance rows a structural no-op for `remove` — `strips: []` means `stripPrefixes: []` means the `some()` is always false.
4. **Compute `add`.** A label is in `add` iff it's in `after.labels` and NOT in `before.labels`. `add ⊆ after.labels` by construction; the AC invariant ("never synthesize") follows directly.
5. **Return `{ add, remove }`.** Both are `Label[]` (narrowed by TS from the input types).

**What rule logic lives where:**

- *Which transitions are legal* → `TRANSITIONS` (data). This function only does table lookup.
- *What gets stripped* → `Transition.strips` (data). This function applies the patterns; it does not encode any pattern of its own.
- *What gets added* → derived from `after.labels` minus `before.labels`. The function does not synthesize triggers — those come from the agent's run output (the caller passes them in via `after.labels`).

No transition-rule logic is duplicated outside the table. AC bullet #2 satisfied by construction.

#### Why the strip-prefix slice over `startsWith` directly

`LabelPattern` is `"ready:*" | "needs-rework:*"` (closed set, per #24). The `*` is shorthand the table writer uses for "any label whose name starts with this prefix". The semantics are prefix matching, not glob matching — so the implementation strips the trailing `*` and uses `startsWith`. This mirrors `hasNeedsReworkLabel` in `blockers.ts:62`. If a future `LabelPattern` shape changes (e.g. `ready:?` for single-segment, or a regex), the slice logic in this one place updates; no call site cares.

### Concurrency model

None. Pure synchronous function; no goroutines (we're in TS), no await.

### Error handling

One throw: illegal transition. The thrown `Error` carries both column names so the call site (or a Vitest `toThrow(/from "X" to "Y"/)` matcher) can attribute the failure. No fallback to "no-op delta" — an unrecognized transition is a programmer bug (the dispatcher computed a (from, to) pair that the table doesn't model), and silent fall-through would mask it. Same fail-fast posture as `parseCommitsAhead` in `blockers.ts`.

### File: `test/pipeline/decisions.test.ts`

Mirrors the source-file path. Vitest, written RED-first.

#### Test groups

1. **Per-row delta (AC bullet #4).** Iterate `TRANSITIONS` and assert the expected `{ add, remove }` for each row given a representative `(before, after)` pair built from the row itself. Iteration is the load-bearing bit: adding a row to the table without a matching expected-delta entry is a test-suite failure, not a silent gap.

   ```ts
   // Per-row expected deltas, keyed by `${from}->${to}`. Tests iterate
   // TRANSITIONS and look up the expected row; missing keys = test failure.
   const EXPECTED: Record<string, { before: TransitionState; after: TransitionState; delta: LabelDelta }> = {
     "Inbox->Backlog": {
       before: { column: "Inbox", labels: [] },
       after: { column: "Backlog", labels: [] },
       delta: { add: [], remove: [] },
     },
     "Backlog->In Architecture": {
       before: { column: "Backlog", labels: ["ready:po"] },
       after: { column: "In Architecture", labels: ["ready:po"] },
       delta: { add: [], remove: [] }, // forward auto-advance: column-only move
     },
     // ... one entry per row ...
     "In Documentation->Done": {
       before: { column: "In Documentation", labels: ["ready:documentation"] },
       after: { column: "Done", labels: [] },
       delta: { add: [], remove: ["ready:documentation"] },
     },
     "In Architecture->Backlog": {
       before: { column: "In Architecture", labels: ["needs-rework:po"] },
       after: { column: "Backlog", labels: [] },
       delta: { add: [], remove: ["needs-rework:po"] },
     },
     // ...
   };

   it("every TRANSITIONS row has an expected-delta entry (no silent gaps)", () => {
     for (const t of TRANSITIONS) {
       const key = `${t.from}->${t.to}`;
       expect(EXPECTED, `missing expected delta for row ${key}`).toHaveProperty(key);
     }
   });

   it("decideLabelDelta returns the expected delta for each TRANSITIONS row", () => {
     for (const t of TRANSITIONS) {
       const key = `${t.from}->${t.to}`;
       const exp = EXPECTED[key];
       expect(decideLabelDelta(exp.before, exp.after)).toEqual(exp.delta);
     }
   });
   ```

   Representative-state convention (encoded once, in the developer's `EXPECTED` map):
   - **Forward auto-advance rows** (`strips: []`): `before.labels = after.labels = row.requires`. Column moves; labels are unchanged. Expected: `{ add: [], remove: [] }`.
   - **Done row** (`In Documentation → Done`): `before.labels = [row.requires[0]]`, `after.labels = []`. Terminal cleanup. Expected: `{ add: [], remove: [row.requires[0]] }`.
   - **Rework rows** (cross-column or same-column): `before.labels = [row.requires[0]]`, `after.labels = []`. Trigger consumed. Expected: `{ add: [], remove: [row.requires[0]] }`.

   The developer may keep `EXPECTED` literal (one entry per row) rather than building it programmatically — the explicit form makes a regression point at the failing key. ~30 entries × 4 lines each ≈ 120 lines, the bulk of the test file.

2. **Illegal-transition throw (AC bullet #3).** A handful of (from, to) pairs that are not in `TRANSITIONS` (e.g. `Inbox → In Architecture`, `Done → Backlog`, `Backlog → Done`). Assert the throw and that the message contains both column names.

   ```ts
   it.each([
     ["Inbox", "In Architecture"],
     ["Done", "Backlog"],
     ["Backlog", "Done"],
   ] as const)("throws on illegal transition %s -> %s", (from, to) => {
     expect(() =>
       decideLabelDelta({ column: from, labels: [] }, { column: to, labels: [] }),
     ).toThrow(new RegExp(`from "${from}".*to "${to}"`));
   });
   ```

3. **Invariant: `add ⊆ after.labels` (AC bullet #6).** For every legal transition's representative state from `EXPECTED`, assert `delta.add.every((l) => after.labels.includes(l))`.

   ```ts
   it("delta.add is always a subset of after.labels (no synthesis)", () => {
     for (const [, exp] of Object.entries(EXPECTED)) {
       const delta = decideLabelDelta(exp.before, exp.after);
       for (const l of delta.add) {
         expect(exp.after.labels).toContain(l);
       }
     }
   });
   ```

4. **Invariant: at-most-one-`ready:*` and at-most-one-`needs-rework:*` after applying the delta (AC bullet #5).** For every legal transition's representative state, compute the resulting label set `(before \ remove) ∪ add` and assert that filtered counts are ≤ 1.

   ```ts
   it("after applying the delta, result has ≤1 ready:* and ≤1 needs-rework:* label", () => {
     for (const [, exp] of Object.entries(EXPECTED)) {
       const delta = decideLabelDelta(exp.before, exp.after);
       const removed = new Set<string>(delta.remove);
       const result = [...exp.before.labels.filter((l) => !removed.has(l)), ...delta.add];
       expect(result.filter((l) => l.startsWith("ready:")).length).toBeLessThanOrEqual(1);
       expect(result.filter((l) => l.startsWith("needs-rework:")).length).toBeLessThanOrEqual(1);
     }
   });
   ```

   The invariant is structurally enforced for stripping rows (every stale trigger is in `remove`); it relies on the `EXPECTED` map's representative states for non-stripping rows (the developer must not set `before` to carry two `ready:*` labels with `after` not stripping them). That's the right place for the constraint — the table designer owns "what gets stripped"; the test author owns "what realistic state looks like".

5. **Same-column rework rows are exercised by AC bullet #4** (their keys appear in `EXPECTED`). No special-case test needed — the iteration covers them. Keep `In Architecture->In Architecture`, `In Development->In Development`, `In Code Review->In Code Review` rows in `EXPECTED`; the developer does NOT need to add a separate "same-column rework" describe block.

Total test file: ~150–180 lines. The bulk is the `EXPECTED` literal. Keep `describe`/`it` blocks short and named; total `it` count ≈ 6.

### Implementation order (RED → GREEN, per CLAUDE.md "Test-first")

1. Create `test/pipeline/decisions.test.ts` with `EXPECTED` and the four `it` blocks above. Imports `decideLabelDelta`, `TransitionState`, `LabelDelta` from `../../src/pipeline/decisions.ts`. Run `pnpm test` → fails (file does not exist). RED.
2. Create `src/pipeline/decisions.ts` with the type definitions + function body shown above. Run `pnpm test` → all four `it` blocks pass. GREEN.
3. Run `pnpm typecheck && pnpm lint` → both pass. The function signature uses concrete `Column` / `Label` literal unions, so any typo in `EXPECTED`'s keys / values surfaces at compile time.
4. Append `docs/knowledge/codebase/5.md` matching the precedent in `1.md` / `3.md` / `6.md` / `19.md` / `24.md`. One file, ≤50 lines.
5. Commit. The dispatcher's auto-commit safety net catches the developer's worktree at the end of the run.

If any step fails out of order (e.g. write source first), discard and restart. Test-first is non-negotiable per CLAUDE.md.

### Files touched

- `src/pipeline/decisions.ts` — new, ~50–80 lines (2 type exports + 1 function export)
- `test/pipeline/decisions.test.ts` — new, ~150–180 lines (1 `EXPECTED` map + 4 `it` blocks)
- `docs/knowledge/codebase/5.md` — new, ≤50 lines

No edits to existing source. **No `docs/PROJECT-MEMORY.md` edit in this ticket.** See Open questions §2 — three concurrent feature branches (`feature/2`, `feature/9`, `feature/25`) already touch `PROJECT-MEMORY.md`, and adding a fourth append from `feature/5` would land guaranteed merge conflicts at integration time. The `### decideLabelDelta (#5)` patterns entry is deferred to a follow-up ticket once the trio merges; the per-ticket summary in `docs/knowledge/codebase/5.md` is sufficient short-term documentation. No `src/index.ts` re-export.

## Testing strategy

The four invariant tests *are* the verification. There is no integration target — no consumer of `decideLabelDelta` exists yet. When the first call site lands (pre-dispatch in `src/dispatch/`, or post-run cleanup in `src/loop/`), it will integration-test against a real ticket fixture. This ticket's tests assert only the per-row contract.

The per-row iteration test (group #1) is the load-bearing one: a future PR that adds a transition row to `TRANSITIONS` without a matching `EXPECTED` entry fails immediately, and the failure names the missing key. That's the structural guarantee CLAUDE.md "decideLabelDelta is the only place labels mutate" depends on — every legal transition is exercised, including edge cases like Inbox → Backlog (no-op) and same-column rework.

CI gate: `pnpm typecheck && pnpm test && pnpm lint` (the four steps already wired up by #1).

## Open questions

1. **AC says "16 rows today" but `TRANSITIONS` carries 19.** The discrepancy is in the ticket body, not the table. The per-row iteration test makes it self-correcting (one entry per `TRANSITIONS` row, whatever the count). Recommend leaving the AC text as-is and not back-editing it; the developer's `EXPECTED` map will have 19 entries.

2. **`docs/PROJECT-MEMORY.md` patterns entry deferred.** Three concurrent feature branches (`feature/2` creating the file from base, `feature/9` appending after #24's section, `feature/25` inserting in the #6 section) already touch this file. Adding a fourth append from `feature/5` would produce merge conflicts at integration time. The architect-time branch-overlap check flagged the conflict; the architect-decided trade-off was to scope-trim the developer's writes (defer the patterns entry) rather than block #5 on three unrelated branches. Once the trio merges, a follow-up ticket can fold a `### decideLabelDelta (#5)` entry into `PROJECT-MEMORY.md` alongside any other deferred patterns notes — costs nothing, lets #5 ship.

3. **Should `decideLabelDelta` return `Label[]` or `string[]`?** Spec uses `Label[]` (typed-narrow). Reasoning: the input arrays are typed `readonly Label[]`, so the function's outputs naturally narrow to `Label`. Caller (`src/dispatch/`) feeding raw GitHub labels into this function must narrow at the boundary — that's the right place for the validation, not inside the pure function. If a downstream consumer hits a mismatch (a string label that doesn't match any `Label` literal), the narrowing throw lives in the boundary code, not here.

4. **Should the function de-duplicate `before.labels` / `after.labels`?** Spec says no — caller supplies de-duplicated lists. The GitHub label API guarantees uniqueness, and the `ProjectItem.labels` shape from #19 is already a set. If a real-world bug shows duplicates leaking in, the fix is at the I/O boundary, not here (per #6's narrow-types convention).

5. **Should `decideLabelDelta` accept an optional `extraStrip: LabelPattern[]` for one-off cleanup?** No. The whole point of CLAUDE.md "decideLabelDelta is the only place labels mutate" is that strip patterns are owned by the transition table, not by callers. If a pre-dispatch site needs a strip pattern that's not in any row, the right fix is to add the row (or extend `strips`), not to plumb an override.

## Out of scope (explicit non-goals)

- Wiring `decideLabelDelta` into any consumer. Pre-dispatch (`src/dispatch/`), post-run (`src/loop/`), rework routing (#7's `decideReworkRouting`), done-cleanup — each lands in its own ticket.
- A sibling `decideReworkRouting(before, agentOutputLabels)` function. That's #7. This ticket lands `decideLabelDelta` only.
- A `findTransition(from, to): Transition | null` non-throwing variant. Not currently needed; `decideLabelDelta` throws because every call site has a known-legal transition by construction. Add a non-throwing variant when a real call site asks "is this legal?" without wanting to act on the answer.
- `wip:*` / `error:*` handling in this function. Those labels are managed by agent-run cleanup (set/cleared at dispatch boundaries), not by transition rows. The `Label` union doesn't include them; widening would force fake `requires` rows in the transition table — see #24's spec § "wip:* and error:* are intentionally absent".
- `docs/PROJECT-MEMORY.md` edit. See Open questions §2.
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" bullet explicitly forbids barrel re-exports inside `src/`.
