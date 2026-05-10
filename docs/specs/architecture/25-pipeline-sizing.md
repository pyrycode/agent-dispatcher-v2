# Spec: `src/pipeline/sizing.ts` — XS/S predicates + file-overlap (#25)

## Files to read first

- `CLAUDE.md` § "Sizing" — fixes the thresholds this file encodes (XS `<30`, S `<100`); no M, no escape paragraph
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — forbids `await` / `gh` / `git` / `fs` calls in this file
- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — ceiling for the new file
- `CLAUDE.md` § "Test-first" — RED → GREEN → REFACTOR is mandatory; tests are written and failing before the source file exists
- `CLAUDE.md` § "Don't" — bullet "Don't import from a barrel file (`src/index.ts`) inside `src/`"; bullet "Don't write a defense for a failure mode that hasn't been observed"
- `src/pipeline/blockers.ts` — sibling pure-pipeline file; mirror its shape exactly (top-level comment, local `export interface` for inputs, single concern per file). Note the conservative-comparison style (`=== "OPEN"`) and the "narrow input shape, caller adapts at the boundary" pattern.
- `test/pipeline/blockers.test.ts:1-7` — vitest import pattern (`import { describe, expect, it } from "vitest"`) and relative-path style with `.ts` extension preserved
- `docs/specs/architecture/6-pipeline-blockers.md` — precedent for the spec shape this ticket follows; reuse the same section ordering and conventions
- `biome.json:5-19` — formatter rules `pnpm lint` will enforce on the new file (double quotes, trailing commas all, semicolons, 100-col line width, 2-space indent)
- `package.json:11-18` — gate commands referenced by the AC: `pnpm typecheck`, `pnpm test`, `pnpm lint`

The ticket body itself enumerates the boundary semantics (`<30`, `<100`) and the empty-input contract for `fileOverlapsAny`. Re-read the AC list before implementing — the boundary cases (29/30, 99/100, empty inputs) are the load-bearing test surface.

## Context

`src/pipeline/blockers.ts` (#6) established the pattern for pure-pipeline files. This ticket lands the second such file. It's deliberately small: three predicates that the eventual size-gate caller (in `src/dispatch/`) and overlap-check caller (in `src/loop/`) will compose into the WIP=1 invariant.

The thresholds (`30`, `100`) are stated in `CLAUDE.md` as the policy. Encoding them as exported named constants — rather than inline numeric literals — means a future "off-by-one cleanup" or policy change has to surface the edit in the constants and trip every boundary test, rather than silently drift the gate. This is the same "fail loud rather than silent" reasoning that drives `parseCommitsAhead`'s strict regex check in #6.

`fileOverlapsAny` is a set-intersection check, but expressed as a predicate over GitHub-shaped open-PR objects. The dispatcher's overlap rule (architect's spec § 1.5 in the agents repo, which this codebase enforces) needs a deterministic answer to "does this candidate change touch the same file as any open PR?" — no judgment calls, no fuzzy matching. Exact string match on file paths is the contract.

Out of scope: the dispatcher call sites that *consume* these predicates (`src/dispatch/`, `src/loop/`). Those land in later tickets. This ticket lands the predicates plus their tests, nothing more.

## Design

### File: `src/pipeline/sizing.ts`

Single new file. Two exported constants, two exported input types, three exported predicates. Estimated 30–45 production lines; well under the 200-line hardcap.

#### Exported thresholds

```ts
// Production-line ceilings from CLAUDE.md § "Sizing". Exported as named
// constants so tests pin them and any future policy edit must surface here.
export const XS_MAX_PRODUCTION_LINES = 30;
export const S_MAX_PRODUCTION_LINES = 100;
```

The names embed the unit (`PRODUCTION_LINES`) so a reader at the call site doesn't have to rebuild the mental model of what's being counted. CLAUDE.md is explicit: tests scale linearly and aren't counted; size by what the developer writes as production code.

#### Input types (POJOs, defined in this file)

```ts
export interface SizingDiff {
  // Net production lines the change adds (tests excluded). The caller
  // (src/git/ or equivalent) is responsible for excluding test paths
  // before constructing this shape.
  productionLines: number;
}

export interface OpenPr {
  // Set of file paths this PR touches. Caller maps GitHub's PR-files
  // payload to a string array of paths before handing off; the predicate
  // only ever reads this field.
  touchedFiles: readonly string[];
}
```

Both are intentionally minimal — only the fields the predicates read, mirroring the `Blocker` and `BranchState` pattern in `src/pipeline/blockers.ts`. The GitHub-fetching code returns richer objects; the call site narrows them at the boundary. This keeps test fixtures trivial (`{ productionLines: 29 }`, no GraphQL noise).

Per CLAUDE.md "no barrels inside `src/`," do not re-export these types from `src/index.ts`. Future callers import directly from `./pipeline/sizing.ts`.

#### `isXS(diff: SizingDiff): boolean`

```ts
export function isXS(diff: SizingDiff): boolean {
  return diff.productionLines < XS_MAX_PRODUCTION_LINES;
}
```

Strict less-than. A 29-line diff is XS; a 30-line diff is not. The boundary is documented in CLAUDE.md as `<30`; this predicate encodes that exactly.

#### `isS(diff: SizingDiff): boolean`

```ts
export function isS(diff: SizingDiff): boolean {
  return diff.productionLines < S_MAX_PRODUCTION_LINES;
}
```

Same shape, different threshold. Strict less-than; 99 is S, 100 is not.

Note: `isS` is *not* "S but not XS." Per the AC, an XS-sized diff also satisfies `isS`. The predicates answer "does this fit within the S ceiling?" / "does this fit within the XS ceiling?" — not "what tier is this?" Callers compose them (e.g. `isXS(d) ? "xs" : isS(d) ? "s" : "split"`) when they need a tier.

#### `fileOverlapsAny(touchedFiles, openPrs): boolean`

```ts
export function fileOverlapsAny(
  touchedFiles: readonly string[],
  openPrs: readonly OpenPr[],
): boolean {
  if (touchedFiles.length === 0) return false;
  if (openPrs.length === 0) return false;
  const candidate = new Set(touchedFiles);
  return openPrs.some((pr) => pr.touchedFiles.some((f) => candidate.has(f)));
}
```

Returns `true` iff at least one path in `touchedFiles` appears in any `openPrs[i].touchedFiles`. Both empty cases short-circuit to `false` (vacuously: nothing can overlap with nothing).

Exact string equality on file paths. No path normalization (no `.` resolution, no case folding). Caller's responsibility to canonicalise both sides — typically by reading paths from `git diff --name-only` and `gh pr view --json files`, both of which return repo-root-relative paths in the same form. If a future ticket observes a normalization mismatch, that's the moment to add the normalization helper, not now (CLAUDE.md "no defense for unobserved failure modes").

The `Set` is built once on the smaller-or-equal-cardinality side (`touchedFiles`, the candidate change) so the inner loop is `O(1)` per file. For the input sizes the dispatcher actually sees (a candidate diff of <30 files; <10 open PRs of <30 files each), this is comfortably sub-millisecond — but the `Set` shape is still the right one to write because it makes the intent visible: set intersection.

### Concurrency model

None. Pure functions, synchronous, no shared state. Same as `blockers.ts`.

### Error handling

None of the three predicates can throw on any input shape that satisfies the TypeScript types. Negative `productionLines` is meaningless but won't throw — `-5 < 30` evaluates `true`. The caller is responsible for not passing negative line counts; if observed in practice, add a guard at that point (and a regression test). Today, no defense for an unobserved failure mode.

No try/catch inside the file. No fallbacks. No "fail open." Caller decides.

### File: `test/pipeline/sizing.test.ts`

Mirrors the source-file path. Vitest, written RED-first per CLAUDE.md.

Test groups (each `describe` in the file):

1. **`isXS`** — boundary-pinning cases:
   - `{ productionLines: 0 }` → `true` (trivial change)
   - `{ productionLines: 29 }` → `true` (just under threshold)
   - `{ productionLines: 30 }` → `false` (threshold itself is excluded; AC requirement)
   - `{ productionLines: 100 }` → `false`

2. **`isS`** — boundary-pinning cases:
   - `{ productionLines: 0 }` → `true`
   - `{ productionLines: 29 }` → `true` (XS implies S)
   - `{ productionLines: 99 }` → `true` (just under S threshold)
   - `{ productionLines: 100 }` → `false` (threshold itself is excluded; AC requirement)
   - `{ productionLines: 200 }` → `false`

3. **Threshold constants** — pin the policy values:
   - `expect(XS_MAX_PRODUCTION_LINES).toBe(30)`
   - `expect(S_MAX_PRODUCTION_LINES).toBe(100)`

   These exist so an accidental constant edit fails the test suite even if the boundary cases above were also drifted in the same change.

4. **`fileOverlapsAny`** — overlap and empty-input cases:
   - `([], [])` → `false`
   - `(["a.ts"], [])` → `false` (empty open-PR list)
   - `([], [{ touchedFiles: ["a.ts"] }])` → `false` (empty candidate touched-files)
   - `(["a.ts"], [{ touchedFiles: ["b.ts"] }])` → `false` (no overlap)
   - `(["a.ts"], [{ touchedFiles: ["a.ts"] }])` → `true` (single-file overlap)
   - `(["a.ts", "b.ts"], [{ touchedFiles: ["c.ts"] }, { touchedFiles: ["b.ts", "d.ts"] }])` → `true` (overlap on the second PR, on the second candidate file — exercises both inner-loop traversals)
   - `(["A.ts"], [{ touchedFiles: ["a.ts"] }])` → `false` (case-sensitive — pin the no-normalization contract)

Each `describe` group corresponds to one cluster of AC bullets. One assertion per row. No shared fixtures; inputs are short and inlining them keeps each test readable.

### Implementation order (RED → GREEN, per AC)

1. Create `test/pipeline/sizing.test.ts` with all assertions, importing from `../../src/pipeline/sizing.ts`. Run `pnpm test` → fails (file does not exist yet). RED.
2. Create `src/pipeline/sizing.ts` with the two constants, two interfaces, and three predicates. Run `pnpm test` → passes. GREEN.
3. Run `pnpm typecheck && pnpm lint` → both pass.
4. Commit source + tests + spec.

If any step fails out of order (e.g. you write the source first), discard and restart. CLAUDE.md is explicit on test-first.

### Files touched

- `src/pipeline/sizing.ts` — new, ~30–45 lines
- `test/pipeline/sizing.test.ts` — new, ~50–70 lines (one `it` per assertion row)
- `docs/specs/architecture/25-pipeline-sizing.md` — this spec, committed alongside the source

No edits to existing files. No `src/index.ts` re-export (CLAUDE.md forbids barrel re-exports inside `src/`).

## Testing strategy

The tests *are* the verification. No integration target until a `src/dispatch/` consumer lands; until then, the predicates are in isolation.

Boundary cases (29/30, 99/100) are the load-bearing surface — if either threshold drifts by one, the dispatcher will mis-size a real ticket. Keep one assertion per boundary row (no `.each` table) so a regression points at the exact failing row in the test output. The two threshold-constant assertions backstop those boundaries: if a future change edits both the constant and the boundary tests in lockstep, the constant assertion still pins the policy value to its CLAUDE.md-documented number.

CI gate: `pnpm typecheck && pnpm test && pnpm lint`.

## Open questions

1. **Is `productionLines` the right field name?** The AC calls it "production-line count." `productionLines` is the natural shortening. Alternative: `productionLineCount`. Either is fine; `productionLines` matches the prevailing terseness in `blockers.ts` (`commitsAhead`, not `commitsAheadCount`). Recommendation: keep `productionLines`.

2. **Should `fileOverlapsAny` accept a `Set<string>` for `touchedFiles` to let the caller hoist the set construction?** Not yet. The caller is constructing a fresh candidate diff per dispatch attempt; building the set inside the predicate keeps the call site simple and the per-call cost is negligible at the input sizes the dispatcher sees. If profiling later shows this on a hot path, change the signature at that point.

3. **Should the predicates return a richer `{ ok, reason }` shape instead of `boolean`?** No. Pure predicates return `boolean`. The caller composes the explanation when it routes the ticket (e.g. when emitting a comment back to PO explaining why a ticket was split). Pushing the reason into the predicate would re-introduce the kind of ad-hoc message-coupling that the central `decideLabelDelta` rule is meant to prevent.

4. **Path normalization in `fileOverlapsAny`.** Spec says no — exact string match, caller canonicalises. CLAUDE.md "no defense for unobserved failure modes" applies. If we observe a real ticket where two PRs touched the same file under different path forms (`./src/x.ts` vs `src/x.ts`), add a normalization helper at that moment with a regression test pinning the case.

## Out of scope (explicit non-goals)

- Wiring these predicates into `src/dispatch/` or `src/loop/` — those modules don't exist yet; consumer tickets will import from this file.
- A "tier" function (`sizeTier(diff): "xs" | "s" | "split"`) that composes `isXS` + `isS`. Callers compose them inline; if multiple call sites need the same composition later, extract at that moment.
- Path normalization, glob matching, or directory-prefix overlap in `fileOverlapsAny`. Exact string equality only; richer matching is a downstream ticket if observed.
- Counting production lines from a `git diff` blob. That's an I/O concern (`src/git/`), not a pipeline concern. The predicates here take the count as input.
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" bullet explicitly forbids barrel re-exports inside `src/`.
- Any change to PO sizing rules, label transition tables, or the central `decideLabelDelta` function. Those are downstream tickets that will *consume* the predicates here.
