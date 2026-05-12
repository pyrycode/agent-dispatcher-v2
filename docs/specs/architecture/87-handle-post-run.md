# Spec — `handlePostRun`: dispatch happy-path arms `ready:<agent>` on the issue

Ticket: [#87](https://github.com/pyrycode/agent-dispatcher-v2/issues/87) — split from #77, consumes the classifier discriminant landed by sibling #86.

## Files to read first

- `src/pipeline/transitions.ts:37-51` — the comment block above the `Label` union pins **why** `wip:*` / `error:*` are exempt from the "every label mutation funnels through `decideLabelDelta`" invariant. This spec's chosen carve-out cites these lines as the precedent.
- `src/pipeline/transitions.ts:73-90` — the forward-auto-advance rows. Every `ready:*` label is consumed as a `requires` of a forward row (`ready:po` → Backlog→In Architecture, `ready:architect` → In Architecture→In Development, ...). The post-run phase *arms* one of these requires; the transition itself fires later in `decideAutoAdvance`. The mental model "the add isn't the transition" comes from staring at this table.
- `src/pipeline/decisions.ts:30-50` — `decideLabelDelta`'s exact contract: looks up a row by `(from, to)` only, uses `requires` only for its existence; doesn't disambiguate. Establishes why the "add a degenerate same-column row with empty `requires`/`strips`" approach can't work without modifying this function (see §"Why the carve-out, not a TRANSITIONS row").
- `src/pipeline/selection.ts:24` — the `Agent` union (`"po" | "architect" | "developer" | "code-review" | "documentation"`). Pairs 1:1 with the `ready:*` half of the `Label` union, so `` `ready:${state.agent}` `` is a member of `Label` by construction.
- `src/dispatch/state.ts` (full file, 20 lines) — the shared `DispatchState`. Use `state.agent` and `state.issueNumber` only; do **not** extend the interface.
- `src/dispatch/handleDispatchError.ts` (full file, 64 lines) — the immediate sibling. Same module shape: `(state, deps)`, `Pick<GitHubLabelsClient, "addLabel">`, type-only import from `src/github/`, header comment that pins the carve-out and cites `transitions.ts:38-41`. Mirror this layout precisely. **One inversion** vs. that sibling: `handlePostRun` propagates `addLabel` errors instead of swallowing them (see §"Error handling").
- `src/salvage/draft-pr.ts` — the `error:max_turns_salvaged` applier; same `Pick<...>` shape; the architect pattern of carving-out a dispatcher-state label add from `decideLabelDelta` first lived here.
- `src/pipeline/classifyAgentResult.ts` (full file, 20 lines) — `AgentResultClass = "ok" | "agent-error"`. Confirms the discriminant the orchestrator branches on; this phase is the `"ok"` arm.
- `test/dispatch/handleDispatchError.test.ts` (full file, 119 lines) — reuse `fakeLabels({ onAdd })` and `makeState(overrides?)` verbatim. The shapes drop into this ticket with the logger plumbing removed.

## Context

Sibling #86 landed `classifyAgentResult: StreamParseResult → "ok" | "agent-error"`. The future dispatcher orchestrator (parent #77) will branch on that discriminant:

```typescript
const cls = classifyAgentResult(parsed);
if (cls === "ok") {
  await handlePostRun(state, deps);
} else {
  await handleDispatchError(/* agent-error path, separate sibling */);
}
```

This ticket lands the `"ok"` arm. The contract is narrow:

1. **Arm the next transition.** Add `ready:<state.agent>` on the issue. The forward-auto-advance row that consumes that label (e.g. `In Architecture → In Development` requires `ready:architect`) fires on the next dispatcher cycle via `decideAutoAdvance` → `decideLabelDelta`. The column does not change here.
2. **No status mutation.** The project-board Status field mirrors the column. Since the column doesn't change, Status doesn't either. The phase therefore does not depend on `GitHubProjectClient`.
3. **Propagate I/O errors.** Unlike `handleDispatchError`'s catch-path contract (never rethrow), this happy-path callee lets `addLabel` failures bubble. The orchestrator's outer try/catch then routes them through `handleDispatchError`, which tags `error:dispatch`. That keeps the failure visible on the issue rather than silently leaving the ticket without `ready:<agent>` (which would re-dispatch on the next cycle as if the agent had never run).

## Design

### File layout

One new production file, one new test file. Net-new — no consumer call sites change. (The orchestrator that wires this in is the follow-up split from #77.)

```
src/dispatch/handlePostRun.ts        — new, ≤50 lines
test/dispatch/handlePostRun.test.ts  — new
```

No edits to `src/pipeline/`, `src/github/`, `src/loop/`, `src/dispatch/state.ts`, or any sibling under `src/dispatch/`. No barrel changes (CLAUDE.md: internal imports are direct).

### Why the carve-out, not a TRANSITIONS row

The ticket's "Open architecture seam" lists three candidates. The decision is **carve-out** (option C). One-line rationale: the post-run `ready:<agent>` add does not change the column, so no row of `TRANSITIONS` describes it; treating it as a transition would require either a degenerate same-column row that collides with the existing rework rows or a contract change to `decideLabelDelta` to disambiguate by `requires`. Both are heavier than mirroring the established `wip:*` / `error:*` precedent.

Long form, for the record:

- **Option A — degenerate same-column TRANSITIONS row with `requires: [], strips: []`.** `decideLabelDelta` looks rows up by `(from, to)` only and uses `find()` — first match wins, `requires` is structural data the lookup never reads (`decisions.ts:31`). For every agent-consumed column there is already a same-column rework row (e.g. `In Architecture → In Architecture` with `requires: ["needs-rework:architect"], strips: ["ready:*", "needs-rework:*"]`, `transitions.ts:104-108`). Adding a second row with the same `(from, to)` either shadows the rework row (if inserted first) or is unreachable (if inserted last). Cannot be made to work without changing `decideLabelDelta`.

- **Option B — extend `decideLabelDelta` to disambiguate by `requires`.** Would make `find()` pick the row whose `requires` are all present in `before.labels`. Plausible in isolation, but breaks `runDoneCleanup` (`src/loop/runDoneCleanup.ts:46-50`): that caller passes the actual `In Documentation` item labels as `before` and relies on the `In Documentation → Done` row being found even when the item no longer carries `ready:documentation` (the cleanup loop runs *after* the transition, with the label already stripped server-side or never present). A `requires`-aware lookup would silently skip the Done row in that path, leaking stale labels. Out of scope; rejected.

- **Option C — carve-out, parallel to `wip:*` / `error:*`.** The carve-out at `transitions.ts:37-41` says: labels that are dispatcher state / metadata, not transition *triggers*, stay out of the `Label` union and bypass `decideLabelDelta`. `ready:*` IS in the `Label` union — it's a transition trigger. The subtle adaptation here: the act of *adding* `ready:<agent>` post-run does not itself fire a transition; it merely arms one for the next cycle. So the carve-out is not "this label isn't a transition label" but "this label-add isn't a transition-firing event". The file header makes this distinction explicit. The forward auto-advance transition that later *consumes* the same `ready:<agent>` label as a `requires` still funnels through `decideLabelDelta` (`decideAutoAdvance` is the caller), which preserves the AC's "transition-trigger label mutations funnel through `decideLabelDelta`" — the *mutation* in that AC bullet means the column-changing mutation, not every touch of a `ready:*` label by any module.

### Which classifier output to take

The classifier discriminant is `"ok" | "agent-error"`; this phase handles only `"ok"`. Passing the literal adds no information to the function body. The full `StreamParseResult` adds no information either — the body neither inspects exit codes nor reads stdout/stderr; it only needs the issue number and the agent name. Decision: **`handlePostRun(state, deps)` — no classifier input.** The orchestrator does the `cls === "ok"` test at the call site, where the discriminant is meaningful; the call into `handlePostRun` is the consequence, not the condition. Narrowest shape this phase actually reads.

### Module header

The header comment must, in this order:

1. Name the function's contract (called from the happy-path branch when the classifier returns `"ok"`; arms `ready:<agent>` on the issue; column unchanged; propagates I/O errors).
2. State the carve-out: this add does not move the ticket between columns, so no `TRANSITIONS` row describes it; cites the precedent at `src/pipeline/transitions.ts:37-41`. Crucially, the comment must clarify the subtle adaptation versus the `wip:*` / `error:*` precedent — `ready:*` is in the `Label` union, but the post-run *add* is not the transition; the consuming forward row (e.g. `transitions.ts:80`) is.
3. State the "no status mutation" decision and why (project-board Status mirrors the column; column doesn't change).
4. State the error contract: rethrow, not swallow — the orchestrator's outer try/catch routes failures through `handleDispatchError`.

### Exports

```typescript
// src/dispatch/handlePostRun.ts

import type { GitHubLabelsClient } from "../github/labels.ts";
import type { Label } from "../pipeline/transitions.ts";
import type { DispatchState } from "./state.ts";

export interface HandlePostRunDeps {
  readonly labels: Pick<GitHubLabelsClient, "addLabel">;
}

export async function handlePostRun(
  state: DispatchState,
  deps: HandlePostRunDeps,
): Promise<void>;
```

Imports: type-only on `GitHubLabelsClient` and `Label`; the body never references the concrete class. Nothing else. No `src/github/` value-import, satisfying the AC's "no direct calls into `src/github/`" bullet.

`HandlePostRunDeps` is the only new exported type. No `DispatchState` extension (AC: "Extend it if a field is missing, but only with what this phase actually reads" — nothing is missing).

### Function body

```typescript
export async function handlePostRun(
  state: DispatchState,
  deps: HandlePostRunDeps,
): Promise<void> {
  const readyLabel = `ready:${state.agent}` satisfies Label;
  await deps.labels.addLabel(state.issueNumber, readyLabel);
}
```

Notes for the developer:

- `Agent` from `selection.ts:24` is a literal union; TypeScript's template-literal inference makes `` `ready:${state.agent}` `` a literal-union subset of `Label`. The trailing `satisfies Label` is the compile-time guarantee — it does not narrow the runtime value, it asserts assignability. If `satisfies` produces friction (e.g. TS version surprises), the equivalent `const readyLabel: Label = \`ready:${state.agent}\`` is acceptable. The intent is "make adding a new agent without adding its `ready:*` label to the union a type error."
- No try/catch. `addLabel` propagates per `src/github/labels.ts:43` ("addLabel THROWS on transport failure"); this phase relies on that contract.

### What the function does NOT do

- Does **not** consult `decideLabelDelta` (see §"Why the carve-out").
- Does **not** remove any labels. Strip semantics fire on transitions; this phase doesn't transition. Note: a happy-path run *may* leave `wip:<agent>` behind on the issue if the in-flight `wip:*` add lands in a future ticket — that's not this phase's concern; the next forward transition (or rework routing) is responsible for clearing it via the documented strip prefixes.
- Does **not** touch the project-board Status field. No `GitHubProjectClient` dep is injected.
- Does **not** parse the classifier output, the stream, or the worktree. The orchestrator has already established this is the `"ok"` branch.
- Does **not** swallow errors. See §"Error handling".

## Concurrency model

Single async call (`addLabel`). No fan-out, no `AbortSignal`, no timers. The caller awaits the return; on resolution the orchestrator continues. The function holds no state across calls — safe to invoke once per per-ticket happy-path dispatch.

## Error handling

Inverse of `handleDispatchError`. The deliberate inversion vs. the sibling:

| Caller's path | `addLabel` outcome | Function behaviour |
|---|---|---|
| happy-path (`cls === "ok"`) | resolves | resolves void; `ready:<agent>` is now on the issue, the next auto-advance cycle will move the column |
| happy-path (`cls === "ok"`) | throws (transport / 4xx/5xx) | rejects with the same error; orchestrator's outer try/catch routes through `handleDispatchError`, which tags `error:dispatch` |

Why propagate (against the "fewer thrown errors" intuition):

- Swallow-and-log would leave the issue **without** `ready:<agent>` but **also** without any visible marker. The ticket would re-enter selection on the next cycle (no `wip:*`, no `ready:*`, no `needs-rework:*` ⇒ eligible) and the agent would run again. The architect-success was just thrown away.
- Propagation funnels the failure through the orchestrator's outer try/catch → `handleDispatchError` → `error:dispatch` label. The ticket carries a visible "the dispatcher failed after the agent succeeded" marker for the next operator pass; rework routing strips `error:*` via `STRIP_PREFIXES` (`routing.ts:29`) when a human triages it.
- The `error:dispatch` label name is accurate: "dispatch" means "dispatcher-side processing", which includes post-run, not just the agent invocation. The handleDispatchError spec's `phase: "dispatch"` literal already encompasses both invocations.

CLAUDE.md "Don't write a defense for a failure mode that hasn't been observed" applies in reverse here: the silent re-dispatch failure mode is the **default** if we swallow; propagation is the simpler code path *and* the safer one.

## Testing strategy

Three unit tests in `test/dispatch/handlePostRun.test.ts`. Reuse `fakeLabels({ onAdd })` and `makeState(overrides?)` verbatim from `test/dispatch/handleDispatchError.test.ts:9-18` and `:34-42`. No logger fake needed — this phase doesn't log.

**Test 1 — happy path applies `ready:<agent>`.** Use `makeState({ agent: "architect", issueNumber: 87 })`. Assert `labels.calls` equals `[{ number: 87, name: "ready:architect" }]`. The function resolves to `undefined`. Pins AC bullet "the resulting label adds … are observed on the fake".

**Test 2 — per-agent label naming.** Drive the function once for each `Agent` value (`"po"`, `"architect"`, `"developer"`, `"code-review"`, `"documentation"`). For each, assert the recorded label is exactly `ready:<agent>`. Compact parametrized test (`it.each([...])` or a small loop inside one `it`). Pins the `Label`-typed template-literal construction against an Agent member being added without its `ready:*` label being added to the `Label` union — the test would compile-fail before runtime if the union drifts.

**Test 3 — `addLabel` rejection propagates.** Configure `fakeLabels({ onAdd: () => { throw new Error("HTTP 500"); } })`. Call `await expect(handlePostRun(state, deps)).rejects.toThrow("HTTP 500")`. Pins the "Error handling" §: failure bubbles to the orchestrator's outer try/catch. Inversion vs. `handleDispatchError`'s `.resolves.toBeUndefined()` test; this is the structural contrast that lets the orchestrator route post-success dispatcher errors to `error:dispatch`.

The three tests collectively pin every behavioural AC bullet. The "no `decideLabelDelta` call" / "carve-out documented in header" / "no value-import from `src/github/`" bullets are static and reviewed on commit.

## Acceptance-criteria → test/assertion mapping

| AC bullet | Where it's pinned |
|---|---|
| Exported from `src/dispatch/`, takes `(state, deps)`, applies post-run label via injected I/O | Tests 1 + 2 (assert `labels.calls`) |
| Transition-trigger mutations funnel through `decideLabelDelta`; carve-out documented in header | Manual review on commit — header comment §"Module header" enumerates the four required points |
| No direct calls into `src/github/`; type-only imports OK | Imports list in §"Exports" is `type`-only; review on commit |
| Unit tests cover happy path, label adds observed on fake, status change (if any) recorded | Tests 1 + 2; no status I/O dep, so "(if any)" branch is the documented null |
| File ≤100 lines | Production file fits in ~15 lines of code; full file with header comment ~50 lines |
| `pnpm typecheck && pnpm test` pass | Run before commit |

## Open questions

None. The three architect seams flagged in the ticket (carve-out vs. transitions-row, classifier-input shape, status mutation) are resolved in §"Design"; the error-propagation choice is resolved in §"Error handling".
