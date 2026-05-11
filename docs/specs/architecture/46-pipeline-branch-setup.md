# Spec: `src/pipeline/branch-setup.ts` — `decideBranchSetup` + `shouldAutoCommit` pure predicates (#46)

## Files to read first

- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — explicit ban on `await` / `gh` / `git` / `fs` in this directory; the reason this file lives in `src/pipeline/` and not `src/worktree/` despite the parent split (#11) listing it under worktree.
- `CLAUDE.md` § "Belt-and-suspenders" — names `shouldAutoCommit` as the deterministic backstop to the architect's "commit your spec" prose. Read the rationale before you decide which fields to expose.
- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — the file should land at 50–100 lines; sets the boundary.
- `CLAUDE.md` § "Don't" — the no-barrels rule (no `from "../index.ts"` inside `src/`) and the "no defense for unobserved failure modes" rule (constrains scope; do not pre-build for hypothetical agent variants).
- `CLAUDE.md` § "Test-first" — RED → GREEN → REFACTOR is mandatory, not advisory.
- `src/pipeline/blockers.ts:1-65` — reference module. Mirror its shape (top-of-file comment block, `export interface` POJOs, single concern per export, no I/O). The internal `hasNeedsReworkLabel` helper at `:62-64` is the prefix-match shape this ticket reuses.
- `src/pipeline/sizing.ts:1-42` — second precedent for the same pattern; named exported constants at top, narrow POJO inputs, exhaustive predicates.
- `src/pipeline/routing.ts:28-48` — third precedent; shows the `needs-rework:` prefix-match pattern in production use (not just `blockers.ts`'s helper).
- `test/pipeline/blockers.test.ts:65-87` — the four-row truth-table test pattern (`shouldFlagEmptyBranch` describe block). Mirror this structure: one `it()` per row, inline literal inputs, no shared fixtures. Note the prefix-vs-substring guard at `:82-86` — replicate it for `shouldAutoCommit`.
- `test/pipeline/sizing.test.ts:1-9` — vitest import pattern, `.ts` extension preserved on the relative source-file import.
- `biome.json:5-19` — formatter rules `pnpm lint` enforces (double quotes, trailing commas all, semicolons always, 100-col, 2-space). Write to this style or lint fails.
- `package.json` — confirms `pnpm typecheck && pnpm test && pnpm lint` are the gate commands the AC names.

The ticket body itself enumerates the two truth tables. Re-read the AC list before implementing — the truth tables are the load-bearing test surface.

## Context

This ticket lands two more pure predicates in `src/pipeline/`. Both surround the dispatch phase: `decideBranchSetup` chooses the worktree branch name (fresh `feature/<n>` vs reuse of an existing PR's head ref), and `shouldAutoCommit` is the deterministic backstop for the architect's prose instruction "commit your spec."

The placement is a deliberate override of the parent split (#11), which listed this file under `src/worktree/` for cohesion. CLAUDE.md's purity rule wins: these predicates have zero I/O, so they live with their pure-function siblings (`blockers.ts` #6, `sizing.ts` #25, `routing.ts` #31) where the test-shape and import conventions are identical. The ticket body acknowledges this explicitly. The worktree-side I/O code that *consumes* these predicates (e.g. `src/worktree/create.ts` #44 already landed) lives in `src/worktree/` separately.

`shouldAutoCommit` is a textbook belt-and-suspenders pair. The architect agent's CLAUDE.md prompt says "you MUST commit your spec" — the dispatcher needs a deterministic check that fires when the agent forgot. The truth table disambiguates the four observable post-run states:

| `commitsAhead` | `stagedChangesPresent` | `needs-rework:*` | meaning | auto-commit? |
|---|---|---|---|---|
| `> 0` | any | any | the agent already committed | `false` |
| `=== 0` | `false` | any | silent fail (no work at all) | `false` (this is `shouldFlagEmptyBranch`'s domain) |
| `=== 0` | `true` | no | silent success — agent did the work but forgot to commit | **`true`** — the safety net fires |
| `=== 0` | `true` | yes | deliberate bail with staged-but-not-committed work | `false` (label is the explicit handoff signal) |

The middle two rows are the disambiguator. Without the staged-changes input, the predicate cannot tell silent-success-with-staged-work apart from silent-fail-with-nothing — the former should auto-commit; the latter should escalate to `error:*`.

`decideBranchSetup` is simpler: PR-existence is the deterministic disambiguator for fresh-vs-reuse. A re-routed ticket (with a `needs-rework:*` label) but no PR yet is still a "create" — the agent's first run produces the branch. Once a PR exists on `feature/<n>` and the ticket gets routed back, the next agent run reuses that branch so the PR's history stays continuous. This matches v1 dispatcher semantics; the ticket body is explicit that the label is NOT consulted here.

Out of scope: the dispatcher call sites that *consume* these predicates. Those live in `src/dispatch/` (not yet landed) and `src/loop/`. This ticket lands the predicates plus their tests, nothing more.

## Design

### File: `src/pipeline/branch-setup.ts`

Single new file. Two exported predicates plus a small set of POJO interfaces. One internal helper (`hasNeedsReworkLabel`) — the second-consumer promotion of the unexported helper currently in `blockers.ts:62-64`. Estimated 50–80 production lines; well under the 200-line hardcap.

#### Top-of-file comment

Mirror the `blockers.ts:1-7` shape. Three lines max:

```ts
// Pure predicates for branch-setup choice and the auto-commit safety net.
//
// `decideBranchSetup` picks the worktree's branch name (fresh feature/<n> vs
// reuse of an existing PR's head ref). `shouldAutoCommit` is the deterministic
// backstop for the architect's "commit your spec" prose — see CLAUDE.md
// § "Belt-and-suspenders". Pure: no await, no gh / git / fs. Callers in
// src/dispatch/ and src/loop/ supply the inputs.
```

#### Input + output types

All defined locally; no imports from `src/pipeline/blockers.ts` (that would couple two unrelated predicates). Per the #6 narrow-types rule, each interface lists only the fields the predicate actually reads.

```ts
export interface BranchSetupState {
  issueNumber: number;
  // labels included in the shape so callers can pass through their canonical
  // ticket-state object even though decideBranchSetup itself does not read it.
  // (Reserved for future input growth — keeping the shape stable lets callers
  // forward one object to several predicates. If symmetry feels too loose,
  // drop this field; the tests below do not assert it is read.)
  labels: readonly string[];
  // PR head ref of the existing PR for this issue, or null if no PR exists.
  // Caller (src/github/) maps GitHub's PR query result to either the ref
  // string (e.g. "feature/42") or null before handing off.
  existingPrHeadRef: string | null;
}

export type BranchSetupDecision =
  | { readonly kind: "create"; readonly branch: string }
  | { readonly kind: "reuse"; readonly branch: string };

export interface AutoCommitState {
  commitsAhead: number;
  stagedChangesPresent: boolean;
  labels: readonly string[];
}
```

Notes:

- `BranchSetupState.labels` is included for shape-symmetry with `AutoCommitState`. The predicate does NOT read it (the AC is explicit: "the `needs-rework:*` label is NOT consulted directly"). Callers pass their canonical ticket-state object through; the field exists so we don't force them to construct a separate stripped-down object. The tests below cover the both-with-and-without-rework rows to lock in this non-coupling. **If the implementer prefers a tighter type — drop `labels` from `BranchSetupState` and have callers narrow at the call site — that is also acceptable.** Either choice is defensible; the Open question below records the tradeoff. Pick one and stick with it.
- `BranchSetupDecision` is a discriminated union on `kind`, exactly as the AC prescribes. The `branch` field is non-empty in both arms; we do not encode the issue number separately because the caller already has it (and `feature/<n>` is the only format).
- `AutoCommitState` is the truth-table input, three fields, narrow.
- No `BranchSetupDecision` member is exported as its own type — the union is the public surface.

#### `decideBranchSetup(state: BranchSetupState): BranchSetupDecision`

```ts
export function decideBranchSetup(state: BranchSetupState): BranchSetupDecision {
  if (state.existingPrHeadRef !== null) {
    return { kind: "reuse", branch: state.existingPrHeadRef };
  }
  return { kind: "create", branch: `feature/${state.issueNumber}` };
}
```

That's the entire body. Two branches, no helpers needed. The `feature/<n>` template is the only branch-name format we ship today; per the ticket's technical note, "if a future ticket needs a different prefix per agent, extend the input shape rather than threading a constant."

The label is not read. The four AC test rows prove this: same `existingPrHeadRef` value yields the same decision regardless of `needs-rework:*` presence.

#### `shouldAutoCommit(state: AutoCommitState): boolean`

```ts
export function shouldAutoCommit(state: AutoCommitState): boolean {
  if (state.commitsAhead > 0) return false;
  if (!state.stagedChangesPresent) return false;
  if (hasNeedsReworkLabel(state.labels)) return false;
  return true;
}
```

Three guards in order; returns `true` only at the bottom. Order matters for readability, not for correctness — the conjunction is symmetric.

The truth table from the Context section maps directly:

| `commitsAhead` | `stagedChangesPresent` | `needs-rework:*` | result |
|---|---|---|---|
| `> 0` | any | any | `false` (first guard) |
| `=== 0` | `false` | any | `false` (second guard) |
| `=== 0` | `true` | no | `true` (falls through) |
| `=== 0` | `true` | yes | `false` (third guard) |

Per the AC, the predicate does NOT inspect agent identity. The per-agent gate (which agents are eligible for auto-commit at all) is the caller's concern — they compose with `shouldProduceCommits` from `blockers.ts:47-60`, or with a future `shouldAutoCommitForAgent` table when the policy diverges. Keep this predicate generic over state.

#### Internal helper: `hasNeedsReworkLabel(labels: readonly string[]): boolean`

```ts
function hasNeedsReworkLabel(labels: readonly string[]): boolean {
  return labels.some((l) => l.startsWith("needs-rework:"));
}
```

This is the second consumer of the same shape currently inlined as an unexported helper at `src/pipeline/blockers.ts:62-64`. The ticket body's technical note flags this as the "second-import promotes" trigger.

**Resolution: copy, do not promote.** Per CLAUDE.md "Don't write a defense for a failure mode that hasn't been observed" and "Don't add a 'while I'm here' refactor in the middle of a ticket": exporting `hasNeedsReworkLabel` from `blockers.ts` and importing it here would couple two pure files for a single five-line helper, and would expand this ticket's diff with a rename across `blockers.ts`. Re-defining the helper as an unexported function in `branch-setup.ts` is one duplicated line; the cost is bounded. If a third consumer appears, file a follow-up ticket to extract both into a shared `src/pipeline/labels.ts` and update both call sites in one move.

The literal `"needs-rework:"` prefix string is repeated across `blockers.ts:63`, `routing.ts:28`, and now `branch-setup.ts`. If a labels-helper module ever lands, it should also pin this constant. For now, the duplication is intentional — three call sites with one stable prefix is cheaper than premature centralisation.

(Note: `routing.ts:28` already exports `REWORK_PREFIX` as a module-local constant. We deliberately do not import that — `routing.ts` is unrelated semantically, and importing a constant for a one-character readability win is the same kind of premature coupling.)

### File: `test/pipeline/branch-setup.test.ts`

Mirrors the source-file path. Vitest, written RED-first per CLAUDE.md.

Test groups (each `describe` in the file):

1. **`decideBranchSetup`** — exactly the four AC matrix rows, one assertion each:

   | row | `existingPrHeadRef` | `labels` | expected |
   |---|---|---|---|
   | a | `null` | `[]` | `{ kind: "create", branch: "feature/42" }` |
   | b | `null` | `["needs-rework:po"]` | `{ kind: "create", branch: "feature/42" }` |
   | c | `"feature/42"` | `[]` | `{ kind: "reuse", branch: "feature/42" }` |
   | d | `"feature/42"` | `["needs-rework:po"]` | `{ kind: "reuse", branch: "feature/42" }` |

   Use `issueNumber: 42` across all four for consistency. Each `it()` name should call out which row it is, e.g. `"creates feature/<n> when no PR exists, regardless of needs-rework label"`.

   Plus one extra structural assertion (not in the AC but cheap): `decideBranchSetup({issueNumber: 7, labels: [], existingPrHeadRef: null}).branch` returns `"feature/7"` — locks the template-string format.

2. **`shouldAutoCommit`** — exactly the four AC truth-table rows, one assertion each:

   | row | `commitsAhead` | `stagedChangesPresent` | `labels` | expected |
   |---|---|---|---|---|
   | a | `1` | `true` | `[]` | `false` (real commit exists) |
   | b | `1` | `true` | `["needs-rework:po"]` | `false` (real commit exists, label too) |
   | c | `0` | `false` | `[]` | `false` (silent fail — `shouldFlagEmptyBranch`'s domain) |
   | d | `0` | `false` | `["needs-rework:po"]` | `false` (silent bail without staged work) |
   | e | `0` | `true` | `[]` | **`true`** (silent-success-with-staged-changes — the safety net fires) |
   | f | `0` | `true` | `["needs-rework:po"]` | `false` (deliberate bail with staged work) |

   Six rows, not four — covering both `commitsAhead > 0` cases (a,b) gives one assertion per AC bullet (the AC bullet "any" expands to two rows). The load-bearing row is (e): the only `true`. If any other row regresses, `shouldAutoCommit` will either silently lose work or auto-commit a bail.

   Plus one prefix-vs-substring guard, mirroring `test/pipeline/blockers.test.ts:82-86`:
   - `{ commitsAhead: 0, stagedChangesPresent: true, labels: ["something-needs-rework:po"] }` → `true` (only true `needs-rework:*` prefix counts as bail).

Each `describe` corresponds to one AC bullet (the predicate it tests). One assertion per row. No shared fixtures; the inputs are 1–4 fields long and inlining them keeps each test readable in isolation. Match `blockers.test.ts:65-87`'s style exactly.

### Implementation order (RED → GREEN → REFACTOR, per AC)

1. Create `test/pipeline/branch-setup.test.ts` with all assertions, importing from `../../src/pipeline/branch-setup.ts`. Run `pnpm test` → fails (file does not exist). RED.
2. Create `src/pipeline/branch-setup.ts` with type definitions + two exports + one internal helper. Run `pnpm test` → all pass. GREEN.
3. Run `pnpm typecheck && pnpm lint` → both pass.
4. Commit with the spec doc.

If any step fails out of order (you write source first), discard and restart. CLAUDE.md is explicit: "Backfilling tests after the fact ships bugs first."

### Files touched

- `src/pipeline/branch-setup.ts` — new, ~50–80 lines.
- `test/pipeline/branch-setup.test.ts` — new, ~70–110 lines (one `it` per row across both predicates).

No edits to existing files. No `src/index.ts` re-export. No promotion of `hasNeedsReworkLabel` out of `blockers.ts` (see Internal helper section above).

The developer should also append the standard per-ticket implementation summary at `docs/knowledge/codebase/46.md` (matching `1.md` / `6.md` / `25.md` precedent) and update `docs/PROJECT-MEMORY.md` with a one-line "Patterns established" entry under a `### src/pipeline/branch-setup.ts (#46)` heading. Docs-touchups, not code; stay within the developer's normal post-implementation pass.

## Concurrency model

None. Pure functions, synchronous, no shared state. The whole point of `src/pipeline/` is that there's nothing to coordinate.

## Error handling

- Both predicates cannot throw on any input shape that satisfies the TypeScript types.
- TypeScript types are a runtime contract held by the caller; if the caller passes `null` as `state.labels` it's a caller bug, not a predicate bug. We do not defensively `?? []`.
- No try/catch in this file. No fallbacks. No "fail open." Caller decides.

## Testing strategy

The tests *are* the verification. There's no integration target until `src/dispatch/` consumers land; until then the predicates are tested in isolation.

The two truth tables are the load-bearing surface. If any one row regresses, the dispatcher will either:
- silently lose staged work (a regression in `shouldAutoCommit` row e), or
- auto-commit work the agent meant to hand off (a regression in row f), or
- start a fresh branch on a ticket that should reuse a PR's head ref (a regression in `decideBranchSetup` rows c/d).

Keep one assertion per row (don't collapse into a `.each`-style table) so a regression points at the exact failing row in the test output.

CI gate: `pnpm typecheck && pnpm test && pnpm lint`.

## Open questions

1. **Should `BranchSetupState.labels` be in the input shape at all?** Two defensible options:
   - **Include it (recommended in this spec)** — callers can pass their canonical ticket-state object to several predicates without constructing per-predicate slices. Cost: one unread field; the test rows lock in that the predicate ignores it.
   - **Drop it** — tighter type, slightly more friction at the call site. Defensible if the implementer feels the extra field invites confusion.

   Either choice satisfies the AC (the AC says the label "is NOT consulted directly," not "is not in the input"). Pick one, document the choice in the file's top comment if dropped.

2. **Should `hasNeedsReworkLabel` be promoted out of `blockers.ts` now (vs duplicated)?** Spec says duplicate; see "Internal helper" section above. If the implementer is also touching `blockers.ts` for an unrelated reason in this ticket (they should not be — this is `src/pipeline/branch-setup.ts` only), the calculus might change. As specified, do not touch `blockers.ts`.

3. **`existingPrHeadRef` empty string vs `null`?** Spec uses `string | null`. `""` would be ambiguous (no ref vs literally-empty ref). The `src/github/` adapter must coerce — when this lands, the adapter ticket should pin that contract.

## Out of scope (explicit non-goals)

- Wiring these predicates into `src/dispatch/` or `src/loop/` — those modules don't exist yet; consumer tickets will import from this file.
- A `BranchSetupState` shape that mirrors GitHub's full PR object. The narrow `{ existingPrHeadRef: string | null }` is sufficient; a richer adapter belongs in `src/github/`.
- Promotion or extraction of `hasNeedsReworkLabel` into a shared `src/pipeline/labels.ts`. Defer until the third consumer lands; file a follow-up at that point.
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" bullet explicitly forbids barrel re-exports inside `src/`.
- A `shouldAutoCommitForAgent(agent, action, state)` per-agent variant. The AC is explicit that `shouldAutoCommit` stays generic over state; per-agent gating is the caller's concern via composition.
- Any change to `blockers.ts`, `routing.ts`, or `transitions.ts`. Those files already encode their own copies of the `needs-rework:` prefix shape; do not refactor while landing this ticket.
