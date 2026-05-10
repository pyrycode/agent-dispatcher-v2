# Spec: `src/pipeline/blockers.ts` — pure predicates for blocker + empty-branch routing (#6)

## Files to read first

- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — sets the file-size and decision-shape ceiling
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — explicitly forbids `await` / `gh` / `git` / `fs` calls in this directory
- `CLAUDE.md` § "Belt-and-suspenders" — names `hasOpenBlockers` and `shouldFlagEmptyBranch` as the two predicates this ticket lands; explains *why* they exist (deterministic backstops to stochastic agent prose)
- `CLAUDE.md` § "Don't" — bullet "Don't import from a barrel file (`src/index.ts`) inside `src/`"; bullet "Don't write a defense for a failure mode that hasn't been observed" (constrains the `(agent, action)` table)
- `CLAUDE.md` § "Test-first" — RED → GREEN → REFACTOR is mandatory for this ticket, not advisory
- `src/paths/agents-root.ts` — module shape this file mirrors (top-level comment, `export interface` for input opts, single `export function`, no I/O)
- `src/paths/target-root.ts` — second example of the same pattern; confirms multi-export-per-file is acceptable when each export is part of one concern
- `test/paths/agents-root.test.ts:1-6` — vitest import pattern (`import { describe, expect, it } from "vitest"`) and relative import path style (`../../src/paths/agents-root.ts` with the `.ts` extension preserved)
- `biome.json:5-19` — formatter rules that biome will enforce on the new file (double quotes, trailing commas all, semicolons always, 100-col line width, 2-space indent). Write the file in this style or `pnpm lint` fails.
- `package.json:11-18` — confirms `pnpm typecheck` / `pnpm test` / `pnpm lint` are the gate commands the AC names

The ticket body itself enumerates the failure mode (`error:architect` false-positive on relay #26 when architect deliberately bailed) and the four-row ambiguity matrix. Re-read the AC list in the ticket before implementing — the matrix is the load-bearing test surface.

## Context

This is the first `src/pipeline/` file. It sets the implementation pattern for everything that follows in that directory: pure functions, POJO inputs, no `await`, no `gh` / `git` / `fs` calls, tests-first. Get this one right and subsequent pipeline tickets cargo-cult correctly; get it wrong and the rewrite's central architectural rule (purity in `pipeline/`, I/O at the edges) erodes from ticket two.

The two named predicates exist because v1's belt-and-suspenders model was incomplete: agents were told via prose ("check for blockers", "remember to commit") to enforce invariants that, when forgotten, shipped broken work downstream. The 2026-05-10 relay #26 incident proved the cost — a naive empty-branch check raised `error:architect` on an architect that had *deliberately* bailed (zero commits, but a `needs-rework:*` label set on the issue indicating the architect routed back to PO on purpose). Conflating silent failure with deliberate bail mis-routes the ticket: an `error:*` label triggers retry; `needs-rework:*` is the agent's signal it intends to hand off. The predicate must inspect labels to disambiguate — which is exactly what makes it pure-function-shaped: no I/O needed, the label list is already in scope at the call site.

`hasOpenBlockers` is the deterministic backstop to the architect agent's "check for blockers" instruction. The agent's prose is ~80% reliable; the dispatcher needs the other 20% guarantee that a ticket with an open `blockedBy` link doesn't get dispatched to a developer who'll waste turns on broken assumptions.

Out of scope: the dispatcher call sites that *consume* these predicates (`src/dispatch/`, `src/loop/`). Those land in later tickets. This ticket lands the predicates plus their tests, nothing more.

## Design

### File: `src/pipeline/blockers.ts`

Single new file. Three exported predicates plus one internal helper. Estimated 60–80 production lines; well under the 200-line hardcap.

#### Input types (POJOs, defined in this file)

```ts
export interface Blocker {
  // Caller (src/github/) maps GitHub's issue state to this string.
  // Only "OPEN" counts as a live blocker; anything else (CLOSED, MERGED,
  // unknown future values) is treated as not-blocking.
  state: string;
}

export interface BranchState {
  commitsAhead: number;     // output of parseCommitsAhead(); see below
  labels: readonly string[]; // GitHub label names on the issue, e.g. "needs-rework:po"
}

export type AgentName = "architect" | "developer" | "code-review" | "documentation";
export type AgentAction = "run"; // see Open question 1; intentionally narrow to start
```

These are local to `blockers.ts`. Per CLAUDE.md "no barrels inside `src/`," do not re-export them from `src/index.ts`. If a future caller (e.g. `src/dispatch/`) needs the same shape, it imports directly from `./pipeline/blockers.ts`.

The `Blocker` interface is intentionally minimal: only the field this predicate reads. The GitHub-fetching code in `src/github/` returns a richer object; the call site narrows it before passing in. This keeps the predicate's test fixtures trivial (`{ state: "OPEN" }`, no GraphQL noise) and makes the predicate trivially mockable.

#### `hasOpenBlockers(blockers: readonly Blocker[]): boolean`

```ts
export function hasOpenBlockers(blockers: readonly Blocker[]): boolean {
  return blockers.some((b) => b.state === "OPEN");
}
```

That's it. Empty list → `false` (vacuously). All-closed → `false`. One-or-more open → `true`. The conservative comparison (`=== "OPEN"`) means unrecognized future states are treated as not-blocking; the alternative (treat unknown as blocking) would deadlock the dispatcher on a single GitHub schema change. If we later observe a state we should treat as blocking, add it explicitly and add a test row.

#### `parseCommitsAhead(gitRevListOutput: string): number`

`git rev-list --count main..HEAD` outputs a single non-negative integer followed by a newline (e.g. `"5\n"`, `"0\n"`). The parser:

1. Trims whitespace.
2. If empty after trim → throw `Error("parseCommitsAhead: empty output")`.
3. If not a non-negative integer literal (regex `/^\d+$/` after trim) → throw `Error(\`parseCommitsAhead: not a non-negative integer: ${input}\`)`.
4. Otherwise return `Number(trimmed)`.

Documented behaviour: throws on malformed input, returns a non-negative integer otherwise. Throwing (vs returning `-1` or `null`) means the caller cannot silently propagate garbage into the empty-branch check. The dispatcher catches at the I/O boundary and decides whether to log + skip or escalate.

Why not parseInt? `parseInt("5abc", 10) === 5` — silent truncation. The whole point of this helper is determinism. `Number("5abc")` returns `NaN`, but the regex check is more direct and produces a better error message.

Why not accept negative numbers? `git rev-list --count` cannot output negatives. A negative value at this layer is a contract violation — fail loud.

#### `shouldFlagEmptyBranch(state: BranchState): boolean`

```ts
export function shouldFlagEmptyBranch(state: BranchState): boolean {
  if (state.commitsAhead > 0) return false;
  if (hasNeedsReworkLabel(state.labels)) return false;
  return true;
}
```

Returns `true` only when both conditions hold:
- `commitsAhead === 0` (the agent produced no commits)
- AND no `needs-rework:*` label is present (the agent did not deliberately bail)

The four ambiguity-matrix rows from the AC map directly:

| `commitsAhead` | `needs-rework:*` present | Result | Interpretation |
|---|---|---|---|
| `> 0` | no | `false` | success-with-commits |
| `=== 0` | no | `true` | silent failure → flag for `error:*` |
| `=== 0` | yes | `false` | deliberate bail → label routing handles it |
| `> 0` | yes | `false` | partial bail → commits exist, rework requested |

The fourth row matters: an agent that committed *and* requested rework (e.g. partial work + label saying "PO needs to clarify scope") is not a silent failure. The empty-branch check has nothing to flag there.

#### Internal helper: `hasNeedsReworkLabel(labels: readonly string[]): boolean`

```ts
function hasNeedsReworkLabel(labels: readonly string[]): boolean {
  return labels.some((l) => l.startsWith("needs-rework:"));
}
```

Not exported (initially). The ticket says: "encode it as a single helper if used in more than one place." It's used in exactly one place right now (`shouldFlagEmptyBranch`). When a second consumer appears (likely in `src/pipeline/transitions.ts` or `src/dispatch/`), promote to `export` at that moment — not preemptively. This is the CLAUDE.md "don't write a defense for a failure mode that hasn't been observed" rule applied to API surface area: don't export until exporting buys something.

#### `shouldProduceCommits(agent: AgentName, action: AgentAction): boolean`

The minimal table:

```ts
export function shouldProduceCommits(agent: AgentName, action: AgentAction): boolean {
  // Every agent run that holds a worktree is currently expected to produce
  // commits on success. The deliberate-bail case is captured by the
  // needs-rework:* label, not by the (agent, action) shape — see
  // shouldFlagEmptyBranch above.
  if (action !== "run") return false;
  switch (agent) {
    case "architect":
    case "developer":
    case "code-review":
    case "documentation":
      return true;
  }
}
```

Why this is so small: the dispatcher (per CLAUDE.md "first ticket verifies the toolchain ... subsequent tickets land `paths/`, `pipeline/transitions.ts`, `pipeline/decisions.ts`") doesn't yet have multiple action shapes per agent. There is currently only one action ("run the agent in its worktree"), and every agent-run that completes successfully is expected to produce at least one commit. The table exists *as a table* (not just `() => true`) so that when a second action appears (e.g. a "dry-run" or "lint-only" mode), the call site can opt out without touching `shouldFlagEmptyBranch`.

If this table grows beyond a handful of entries, that *is* the signal — quoting the ticket's technical note — that the dispatcher is asking the wrong question. Likely refactor at that point: collapse to a property of the action descriptor rather than a side table.

The exhaustive `switch` over `AgentName` (with no `default`) gives us a TypeScript exhaustiveness error at compile time if a new agent is added without updating the table. Cheap + load-bearing.

### Concurrency model

None. Pure functions, synchronous, no shared state. The whole point of `src/pipeline/` is that there's nothing to coordinate.

### Error handling

- `parseCommitsAhead` throws `Error` on malformed input (documented + tested).
- `hasOpenBlockers`, `shouldFlagEmptyBranch`, `shouldProduceCommits` cannot throw on any input shape that satisfies the TypeScript types. (TypeScript types are a runtime contract held by the caller; if the caller passes `null` as `state.labels` it's a caller bug, not a predicate bug. We do not defensively `?? []`.)

No try/catch inside the file. No fallbacks. No "fail open." Caller decides.

### File: `test/pipeline/blockers.test.ts`

Mirrors the source-file path. Vitest, written RED-first per CLAUDE.md.

Test groups (each `describe` in the file):

1. **`hasOpenBlockers`** — four cases:
   - empty list → `false`
   - all closed (`[{state:"CLOSED"}, {state:"MERGED"}]`) → `false`
   - mixed (`[{state:"CLOSED"}, {state:"OPEN"}]`) → `true`
   - all open (`[{state:"OPEN"}, {state:"OPEN"}]`) → `true`

2. **`parseCommitsAhead`** — at minimum:
   - `"5\n"` → `5`
   - `"0\n"` → `0`
   - `"42"` (no trailing newline) → `42`
   - `""` → throws (matches `/empty output/`)
   - `"\n"` → throws (matches `/empty output/` — empty after trim)
   - `"abc"` → throws (matches `/non-negative integer/`)
   - `"5abc"` → throws (regression guard: `parseInt` would have returned 5)
   - `"-1"` → throws (negative literal)

3. **`shouldFlagEmptyBranch`** — exactly the four AC rows, one assertion each:
   - `{commitsAhead: 1, labels: []}` → `false` (success-with-commits)
   - `{commitsAhead: 0, labels: []}` → `true` (silent-fail)
   - `{commitsAhead: 0, labels: ["needs-rework:po"]}` → `false` (deliberate-bail)
   - `{commitsAhead: 1, labels: ["needs-rework:po"]}` → `false` (partial-bail)

   Plus one extra case proving the prefix match isn't a substring match:
   - `{commitsAhead: 0, labels: ["something-needs-rework:po"]}` → `true` (only true `needs-rework:*` prefix counts as bail)

4. **`shouldProduceCommits`** — at minimum:
   - `("architect", "run")` → `true`
   - `("developer", "run")` → `true`
   - `("code-review", "run")` → `true`
   - `("documentation", "run")` → `true`

   No negative cases yet — the type system disallows other `(agent, action)` pairs, and there's no second `action` variant to test against.

Each `describe` group corresponds to one AC bullet. One assertion per row. No shared fixtures; the inputs are 1-3 fields long and inlining them keeps each test readable.

### Implementation order (RED → GREEN, per AC)

1. `mkdir -p src/pipeline test/pipeline` (no `.gitkeep` — the file lands immediately).
2. Create `test/pipeline/blockers.test.ts` with all assertions, importing from `../../src/pipeline/blockers.ts`. Run `pnpm test` → fails (file does not exist yet). This is the RED step.
3. Create `src/pipeline/blockers.ts` with type definitions + four exports. Run `pnpm test` → passes. GREEN.
4. Run `pnpm typecheck && pnpm lint` → both pass.
5. Commit with the spec doc.

If any step fails out of order (e.g. you write the source first), discard and restart. CLAUDE.md is explicit: "Backfilling tests after the fact ships bugs first."

### Files touched

- `src/pipeline/blockers.ts` — new, ~60–80 lines
- `test/pipeline/blockers.test.ts` — new, ~80–110 lines (one `it` per assertion row)

No edits to existing files. No `src/index.ts` re-export (CLAUDE.md forbids barrel re-exports inside `src/`).

The developer should also append the standard per-ticket implementation summary at `docs/knowledge/codebase/6.md` (matching the `1.md` precedent) and update `docs/PROJECT-MEMORY.md` with a short "Patterns established" entry under a new `### src/pipeline/ purity (#6)` heading. These are docs-touchups, not code, and stay within the dev's normal post-implementation pass.

## Testing strategy

The tests *are* the verification. There's no integration target until a `src/dispatch/` consumer lands; until then, the predicates are in isolation.

The four-row ambiguity matrix is the load-bearing surface — if any one row regresses, the dispatcher will mis-route a real ticket. Keep one assertion per row (don't collapse into a `.each`-style table) so a regression points at the exact failing row in the test output.

CI gate: `pnpm typecheck && pnpm test && pnpm lint` (the four steps already wired up by #1).

## Open questions

1. **`AgentAction` shape.** The current model has one action per agent (`"run"`). v1 had richer states (dispatch / salvage / etc.). The minimal type here forces us to revisit the moment a second action appears — likely when the loop module lands and needs to distinguish "normal run" from "salvage retry." Recommendation: defer the richer enum until that ticket; today's `"run"` is honest about today's state.

2. **Should `hasNeedsReworkLabel` be exported now?** Spec says no — promote to export when the second consumer appears. If the implementer believes a second consumer is imminent (e.g. they're already eyeing `src/pipeline/transitions.ts`), exporting now is fine. Either choice is defensible. Recommendation: keep internal until truly needed; one fewer export is one fewer thing to refactor when the rule generalizes (e.g. "is this a hand-off label?" might subsume `needs-rework:*` and `error:*`).

3. **Should `BranchState.labels` accept GitHub's richer label objects (`{name, color, ...}`)?** No. Per the "POJO at the boundary" pattern in CLAUDE.md, the `src/github/` layer narrows to `string[]` before handing off. Keeping the type narrow keeps test fixtures one-line.

4. **`Blocker.state` as a `string` vs a literal union.** Spec uses `string` because the GitHub API can return future state values we haven't enumerated; the predicate's "only `OPEN` blocks" semantics handle that gracefully. If a future ticket wants a closed enum, change the type at that point — it's a non-breaking narrowing for current callers (none yet).

## Out of scope (explicit non-goals)

- Wiring these predicates into `src/dispatch/` or `src/loop/` — those modules don't exist yet; consumer tickets will import from this file.
- A `Blocker` shape that mirrors GitHub's full `IssueState` enum or GraphQL response. The narrow `{state: string}` is sufficient for this predicate; a richer adapter belongs in `src/github/`.
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" bullet explicitly forbids barrel re-exports inside `src/`.
- Seeding `docs/knowledge/architecture/system-overview.md`. PROJECT-MEMORY notes this should land with the first `src/` ticket, but #2 (paths) shipped without it; that's a docs follow-up, not a code change for this ticket.
- Any change to PO sizing rules, label transition tables, or the central `decideLabelDelta` function. Those are downstream tickets that will *consume* `hasOpenBlockers` / `shouldFlagEmptyBranch`; do not pre-build them here.
