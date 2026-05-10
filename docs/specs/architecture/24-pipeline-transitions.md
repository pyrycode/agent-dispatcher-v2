# Spec: `src/pipeline/transitions.ts` — legal-transitions table as data (#24)

## Files to read first

- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — this file is data + types only; no `await`, no `gh` / `git` / `fs` calls
- `CLAUDE.md` § "`decideLabelDelta` is the only place labels mutate" — names this table as the *single* source of truth that `decideLabelDelta` and routing read
- `CLAUDE.md` § "Don't" — bullet "Don't import from a barrel file (`src/index.ts`) inside `src/`"; bullet "Don't write a defense for a failure mode that hasn't been observed" (constrains the `Label` union — narrow now, widen when a transition needs it)
- `CLAUDE.md` § "Test-first" — RED → GREEN → REFACTOR is mandatory for this ticket, not advisory
- `src/pipeline/blockers.ts:62-64` — `hasNeedsReworkLabel` shows the established `startsWith("needs-rework:")` prefix-matching idiom that the `LabelPattern` semantics in this file mirror
- `src/pipeline/blockers.ts:1-7` — header-comment style and "POJO inputs / pure outputs" framing for the directory; new file uses the same shape
- `docs/PROJECT-MEMORY.md` § "src/pipeline/ purity (#6)" — codifies the narrow-input-types convention this ticket follows; in particular "Input types are defined in the same file as the predicate ... intentionally narrow ... don't widen for hypothetical future consumers"
- `docs/specs/architecture/6-pipeline-blockers.md` — the only prior `src/pipeline/` spec; mirrors layout (Files-to-read-first, Design, Testing strategy) for this spec
- `docs/lessons.md` § "Empty-branch check must inspect labels" (#6) — the `needs-rework:*` semantics the rework rows in this table encode
- `biome.json:5-19` — formatter rules biome enforces (double quotes, trailing commas all, semicolons always, 100-col width, 2-space indent). Any line over 100 cols breaks `pnpm lint`.
- `package.json:11-18` — `pnpm typecheck` / `pnpm test` / `pnpm lint` are the gate commands the AC names

The ticket body itself enumerates the four AC invariants (well-formed table, columns reachable from Inbox, every column is a `Column`-type member, no dead-letter `strips` patterns). Re-read the AC before implementing — those are the load-bearing test rows.

## Context

This is the second `src/pipeline/` file (after `blockers.ts`). It lands the **transition table as data only — no logic** so that downstream pure functions (#5 `decideLabelDelta`, #7 `selectDispatches` + `decideReworkRouting`) consume one source of truth. CLAUDE.md is unambiguous: "If you need to add a new label-mutation site, you're doing something wrong — the existing four cover the universe of state transitions." That guarantee only holds if every legal column move + the labels it strips is encoded here, not split across consumers.

The v1 dispatcher kept these rules in three separate places (`AUTO_ADVANCE_RULES`, ad-hoc rework routing, ad-hoc done-cleanup) and the rules drifted: the 2026-05-09 split-out of `pipeline-decisions.ts` documents the asymmetry (auto-advance: no strip; done-cleanup: strip; rework: strip via `runReworkRouting`). v2 unifies all three under one shape so `decideLabelDelta(before, after)` is just a lookup. This ticket lands the lookup table; #5 lands the lookup function.

Out of scope: any consumer of this table. `decideLabelDelta` (#5), `decideReworkRouting` (#7), and the dispatcher call sites (#15, etc.) all import from this file — but each is its own ticket. This ticket lands the data plus its three invariant tests, nothing more.

## Design

### File: `src/pipeline/transitions.ts`

Single new file. Three exported types, two exported constants, no functions. Estimated 60–80 production lines; well under the 200-line hardcap.

#### Type definitions (POJOs / literal unions, defined in this file)

```ts
// The seven Status values on the project board. Inbox is the entry column;
// Done is terminal. Tickets walk Backlog → In Architecture → In Development →
// In Code Review → In Documentation → Done in the happy path; rework routes
// fall back to a prior column.
export type Column =
  | "Inbox"
  | "Backlog"
  | "In Architecture"
  | "In Development"
  | "In Code Review"
  | "In Documentation"
  | "Done";

// Runtime mirror of `Column`. Tests + reachability code need a concrete list
// (TS literal types erase at runtime). The order matches the project board's
// happy-path column order so iteration reads naturally; consumers that need
// a Set should construct one at the call site.
export const COLUMNS: readonly Column[] = [
  "Inbox",
  "Backlog",
  "In Architecture",
  "In Development",
  "In Code Review",
  "In Documentation",
  "Done",
] as const;

// Labels that gate a transition. Per-#6 narrowing rule: only the labels that
// some transition actually requires are members of this union — `wip:*`,
// `error:*`, `size:*`, `priority:*`, `security-sensitive` are dispatcher
// state / metadata, not transition triggers, and stay out until a transition
// actually consumes one. Widen at that point, not preemptively.
export type Label =
  | "ready:po"
  | "ready:architect"
  | "ready:developer"
  | "ready:code-review"
  | "ready:documentation"
  | "needs-rework:po"
  | "needs-rework:architect"
  | "needs-rework:developer"
  | "needs-rework:code-review";

// Wildcard prefix patterns used in `Transition.strips`. The `*` suffix is
// shorthand for "any label whose name starts with this prefix". Same closed
// set rule as `Label`: only patterns whose underlying labels can actually
// gate a transition belong here — keeps the AC#3 invariant test honest.
export type LabelPattern = "ready:*" | "needs-rework:*";

export interface Transition {
  readonly from: Column;
  readonly to: Column;
  // ALL labels in `requires` must be present for the transition to be legal.
  // Empty array = no label requirement (e.g. Inbox → Backlog is a manual
  // human triage move with no label trigger).
  readonly requires: readonly Label[];
  // Patterns of labels to strip on transition. Forward auto-advance rows
  // strip nothing (matches v1's `runAutoAdvance` "no strip" semantics);
  // rework + Done rows strip the trigger family + stale ready labels so the
  // target agent re-runs on a clean slate.
  readonly strips: readonly LabelPattern[];
}
```

These are local to `transitions.ts`. Per CLAUDE.md "no barrels inside `src/`," do not re-export them from `src/index.ts`. Consumers (`decideLabelDelta`, routing, blocker checks) import directly from `./pipeline/transitions.ts`.

#### `TRANSITIONS: readonly Transition[]`

The data. Authored in two clearly-separated blocks (forward then rework) so a reader can scan them; no functional difference.

```ts
export const TRANSITIONS: readonly Transition[] = [
  // ---------- Forward (happy-path auto-advance) ----------
  // Inbox → Backlog is a manual human-triage move (no label trigger).
  // It MUST be in the table — without it, the AC#2 reachability test fails
  // for every column except Inbox.
  { from: "Inbox",            to: "Backlog",          requires: [],                       strips: [] },
  { from: "Backlog",          to: "In Architecture",  requires: ["ready:po"],             strips: [] },
  { from: "In Architecture",  to: "In Development",   requires: ["ready:architect"],      strips: [] },
  { from: "In Development",   to: "In Code Review",   requires: ["ready:developer"],      strips: [] },
  { from: "In Code Review",   to: "In Documentation", requires: ["ready:code-review"],    strips: [] },
  // Done is terminal — strip stale trigger labels so a reopened ticket
  // doesn't carry old `ready:*` / `needs-rework:*` state into a re-run.
  { from: "In Documentation", to: "Done",             requires: ["ready:documentation"],  strips: ["ready:*", "needs-rework:*"] },

  // ---------- Rework (route back to target agent's column) ----------
  // Strips the trigger family + stale ready labels so the target agent
  // re-runs cleanly. Same-column rework rows (`from === to`) are legal
  // state transitions even though the column doesn't change — labels DO,
  // and `decideLabelDelta` is the only place labels mutate.
  { from: "In Architecture",  to: "Backlog",          requires: ["needs-rework:po"],          strips: ["ready:*", "needs-rework:*"] },
  { from: "In Architecture",  to: "In Architecture",  requires: ["needs-rework:architect"],   strips: ["ready:*", "needs-rework:*"] },

  { from: "In Development",   to: "Backlog",          requires: ["needs-rework:po"],          strips: ["ready:*", "needs-rework:*"] },
  { from: "In Development",   to: "In Architecture",  requires: ["needs-rework:architect"],   strips: ["ready:*", "needs-rework:*"] },
  { from: "In Development",   to: "In Development",   requires: ["needs-rework:developer"],   strips: ["ready:*", "needs-rework:*"] },

  { from: "In Code Review",   to: "Backlog",          requires: ["needs-rework:po"],          strips: ["ready:*", "needs-rework:*"] },
  { from: "In Code Review",   to: "In Architecture",  requires: ["needs-rework:architect"],   strips: ["ready:*", "needs-rework:*"] },
  { from: "In Code Review",   to: "In Development",   requires: ["needs-rework:developer"],   strips: ["ready:*", "needs-rework:*"] },
  { from: "In Code Review",   to: "In Code Review",   requires: ["needs-rework:code-review"], strips: ["ready:*", "needs-rework:*"] },

  { from: "In Documentation", to: "Backlog",          requires: ["needs-rework:po"],          strips: ["ready:*", "needs-rework:*"] },
  { from: "In Documentation", to: "In Architecture",  requires: ["needs-rework:architect"],   strips: ["ready:*", "needs-rework:*"] },
  { from: "In Documentation", to: "In Development",   requires: ["needs-rework:developer"],   strips: ["ready:*", "needs-rework:*"] },
  { from: "In Documentation", to: "In Code Review",   requires: ["needs-rework:code-review"], strips: ["ready:*", "needs-rework:*"] },
] as const;
```

Counts: 6 forward rows + 13 rework rows (1 + 2 + 3 + 4 cross-rework + 3 same-column) = **19 rows**.

Notes on the rework-row shape:

- **No `needs-rework:documentation` rows.** The documentation agent is the last forward step; in current practice nothing routes back into documentation as rework target, and #6's narrow-types rule says don't add a label to the union until a transition consumes it. If a future ticket needs it, it's a one-line widening.
- **Same-column rework rows are deliberate.** The v1 spec for `decideReworkRoutes` explicitly notes "Same-column case (target column == source column) IS routed — earlier versions skipped this as a 'self-loop,' but that left the rework label permanently set." Encoding the row here means `decideLabelDelta` reads the strip set from the table even for same-column rework. Without these rows, #5 would have to special-case "label-only" transitions outside the table — directly violating CLAUDE.md "the only place labels mutate."
- **`wip:*` and `error:*` are intentionally absent from `strips`.** They're agent-run lifecycle state (set by pre-dispatch / post-run / safety-net flagging), not transition triggers. Encoding them here would either (a) violate AC#4's invariant ("every `strips` `LabelPattern` matches at least one label produced by some `requires` value") or (b) force fake `requires` rows that don't model any real transition. Keep the table coherent: it encodes the *transition-trigger* lifecycle. wip/error stripping lives in the agent-run cleanup paths.

### Concurrency model

None. Pure data, no functions. The whole point of `src/pipeline/` is that there's nothing to coordinate.

### Error handling

None. There are no functions, so nothing throws. Type-system errors (e.g. an attempt to add a row with an unknown `Column` literal) surface at compile time via `pnpm typecheck`.

### File: `test/pipeline/transitions.test.ts`

Mirrors the source-file path. Vitest, written RED-first per CLAUDE.md.

Test groups (each `describe` in the file maps to one AC bullet):

1. **`Column` reachability from Inbox** (AC#2). One BFS over `TRANSITIONS` starting at `"Inbox"`; assert that every member of `COLUMNS` other than `"Inbox"` is in the visited set. The test should also assert that `"Inbox"` itself is the starting node (so a future regression that drops Inbox from `COLUMNS` is caught).

   ```ts
   it("every Column other than Inbox is reachable from Inbox via at least one chain", () => {
     const visited = new Set<Column>(["Inbox"]);
     const queue: Column[] = ["Inbox"];
     while (queue.length > 0) {
       const cur = queue.shift()!;
       for (const t of TRANSITIONS) {
         if (t.from === cur && !visited.has(t.to)) {
           visited.add(t.to);
           queue.push(t.to);
         }
       }
     }
     for (const col of COLUMNS) {
       expect(visited.has(col), `unreachable: ${col}`).toBe(true);
     }
   });
   ```

   One assertion-per-column inside the loop (with a message naming the failing column) makes a regression point at the exact orphan, matching the #6 spec's "one assertion per row" guidance.

2. **`from`/`to` membership in `Column`** (AC#3). Iterate every row; assert `COLUMNS.includes(t.from)` and `COLUMNS.includes(t.to)`. TypeScript already enforces this at compile time, so the test is a runtime defense against a future `as Column` cast or an `any`-typed extension. Two assertions per row (one for `from`, one for `to`) keep the failure mode obvious.

   ```ts
   it("every from/to is a member of Column (no string literals leaking past the type)", () => {
     for (const t of TRANSITIONS) {
       expect(COLUMNS, `unknown from-column on row ${JSON.stringify(t)}`).toContain(t.from);
       expect(COLUMNS, `unknown to-column on row ${JSON.stringify(t)}`).toContain(t.to);
     }
   });
   ```

3. **No dead-letter `strips` patterns** (AC#4). For each `LabelPattern` that appears in any row's `strips`, assert that at least one row's `requires` contains a label whose name matches that pattern (i.e. starts with the prefix obtained by stripping the trailing `*`).

   ```ts
   it("every strips LabelPattern matches at least one label produced by some requires", () => {
     const allRequiredLabels = new Set<string>();
     for (const t of TRANSITIONS) {
       for (const lbl of t.requires) allRequiredLabels.add(lbl);
     }
     const allStripPatterns = new Set<LabelPattern>();
     for (const t of TRANSITIONS) {
       for (const p of t.strips) allStripPatterns.add(p);
     }
     for (const pat of allStripPatterns) {
       const prefix = pat.endsWith("*") ? pat.slice(0, -1) : pat;
       const covered = [...allRequiredLabels].some((l) => l.startsWith(prefix));
       expect(covered, `dead-letter strip pattern: ${pat}`).toBe(true);
     }
   });
   ```

   Construction of the prefix mirrors the `hasNeedsReworkLabel` idiom in `blockers.ts:62` — `startsWith("needs-rework:")`. If a future `LabelPattern` shape changes (e.g. trailing `:*` vs bare prefix), update the slice logic in this one place; the assertion stays.

4. *(Optional, no-cost regression guard)* **Well-formedness — no row has an unknown `Label` in `requires`**. TypeScript enforces this at compile time, but a one-line runtime check is cheap insurance against `as Label` widenings. Skip if it adds noise; the AC doesn't demand it.

   ```ts
   // Optional. Drop if the test file feels overstuffed.
   it("every requires label is a known Label literal (regression guard)", () => {
     const KNOWN: ReadonlySet<string> = new Set([
       "ready:po", "ready:architect", "ready:developer",
       "ready:code-review", "ready:documentation",
       "needs-rework:po", "needs-rework:architect",
       "needs-rework:developer", "needs-rework:code-review",
     ]);
     for (const t of TRANSITIONS) {
       for (const l of t.requires) {
         expect(KNOWN, `unknown Label on row ${JSON.stringify(t)}`).toContain(l);
       }
     }
   });
   ```

Each `describe`/`it` block is short (5–15 lines). Total test file: ~80–100 lines. No shared fixtures; the tests iterate over the published constants and assert structural invariants.

### Implementation order (RED → GREEN, per AC)

1. Create `test/pipeline/transitions.test.ts` with the three invariant tests, importing from `../../src/pipeline/transitions.ts`. Run `pnpm test` → fails (file does not exist yet). RED.
2. Create `src/pipeline/transitions.ts` with type definitions + `COLUMNS` + `TRANSITIONS`. Run `pnpm test` → all three (or four, if you kept the optional one) pass. GREEN.
3. Run `pnpm typecheck && pnpm lint` → both pass. The exhaustive `Column` literal union catches any typo in a transition row at compile time.
4. Update `docs/PROJECT-MEMORY.md` with a new "Patterns established" entry: `### Transition table (#24)`. One paragraph noting (a) data-only file, no functions; (b) `Label` and `LabelPattern` are intentionally narrow per #6's narrow-types rule; (c) same-column rework rows are deliberate (not bugs).
5. Append `docs/knowledge/codebase/24.md` matching the precedent in `1.md` / `3.md` / `6.md`.
6. Commit (architect's auto-commit safety net catches the spec; the developer commits the code + doc updates).

If any step fails out of order (e.g. you write the source first), discard and restart. CLAUDE.md is explicit on test-first.

### Files touched

- `src/pipeline/transitions.ts` — new, ~60–80 lines (5 type/constant exports + 19 transition rows)
- `test/pipeline/transitions.test.ts` — new, ~80–100 lines (3–4 `it` blocks)
- `docs/PROJECT-MEMORY.md` — append a `### Transition table (#24)` subsection
- `docs/knowledge/codebase/24.md` — new per-ticket implementation summary

No edits to existing source. No `src/index.ts` re-export.

## Testing strategy

The three invariant tests *are* the verification. There is no integration target — no consumer exists yet. When #5 (`decideLabelDelta`) lands, it will read this table and have its own per-row tests asserting the *behavior* the table encodes; this ticket's tests assert only the *shape*.

The reachability test is the load-bearing one: a future PR that adds a column without an inbound transition will be caught immediately, and the failure points at the orphan column by name. That's the structural guarantee CLAUDE.md "decideLabelDelta is the only place labels mutate" depends on — if a column is unreachable, there's no transition row, so `decideLabelDelta` has no entry for it, so labels for that column are *not* mutated through the canonical path. The test catches the silent-divergence failure mode at the source.

CI gate: `pnpm typecheck && pnpm test && pnpm lint` (the four steps already wired up by #1).

## Open questions

1. **`wip:*` / `error:*` in `strips`.** Spec excludes them: they're agent-run lifecycle state, not transition triggers, and including them would either violate AC#4 or force fake `requires` rows. If a downstream consumer (#5) discovers a transition where these *must* be stripped atomically with a column move (currently none observed), the consumer can layer that strip on top — or this table can be widened by adding the missing `requires` row. Recommendation: defer.

2. **`needs-rework:documentation` row(s).** Excluded for now per the #6 narrow-types rule — no observed transition routes back into documentation as a rework target. If a future ticket adds documentation-as-rework-target, widen the `Label` union and add the relevant row(s) (likely just `In Documentation → In Documentation` for self-rework).

3. **Should `Column` be a runtime enum + type, or a string-literal union + runtime mirror constant?** Spec uses the string-literal-union + `COLUMNS` constant pattern. Reasoning: project-board values are already strings ("In Architecture" with the space) and an enum forces `Column.InArchitecture` ergonomics that don't match the GitHub label / project-API string surface. The `as const` runtime mirror is cheap and keeps the literal type available for narrowing.

4. **Should `requires` semantics be ALL or ANY?** Spec says ALL (every label in `requires` must be present). Currently every row has a single-label `requires`, so the choice doesn't matter yet. ALL is the conservative read because it composes monotonically: adding a second required label to a row makes the transition strictly harder to fire. ANY would let one of two alternates fire, which is a different feature (alternate triggers) — defer until a real case forces the question.

## Out of scope (explicit non-goals)

- Wiring `decideLabelDelta`, `decideReworkRouting`, or any blocker check into this table. All consumers land in their own tickets (#5, #7, etc.); this ticket lands the table only.
- A `wip:*` / `error:*` lifecycle column in this table. Those labels are managed by agent-run cleanup, not by board-column transitions.
- Any change to the project board's column structure (Inbox / Backlog / etc.) — those are GitHub project settings, owned by the project, not by code.
- A `Transition` validator function (e.g. `findTransition(before, after): Transition | null`). That belongs in `decideLabelDelta` (#5) — this file is data only, per the "no logic" mandate in the ticket body.
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" bullet explicitly forbids barrel re-exports inside `src/`.
