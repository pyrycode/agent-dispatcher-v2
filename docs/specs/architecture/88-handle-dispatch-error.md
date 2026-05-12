# Spec — `handleDispatchError`: dispatch-error path tags issue with `error:*`

Ticket: [#88](https://github.com/pyrycode/agent-dispatcher-v2/issues/88) — split from #77.

## Files to read first

- `src/pipeline/transitions.ts:37-51` — the `Label` union and the comment that pins **why** `error:*` is excluded from the transition vocabulary. This spec's file header points at these exact lines as the source-of-truth carve-out comment.
- `src/pipeline/routing.ts:28-30` — the `STRIP_PREFIXES = ["ready:", "wip:", "error:"]` list. This is the second half of the carve-out: rework strips `error:*` so a dispatch-error label doesn't survive into the next agent's run.
- `src/dispatch/state.ts` (full file, 20 lines) — the shared `DispatchState` shape the new function consumes. Use `state.issueNumber` and `state.agent` only; do **not** extend the interface.
- `src/salvage/draft-pr.ts` (full file, 43 lines) — the closest sibling: an `error:*` label applier (`error:max_turns_salvaged`) under `src/salvage/` that takes deps via `Pick<GitHubLabelsClient, "addLabel">` and an input record. Mirror the deps shape and the module-header style. Difference: salvage's contract **rethrows** on failure (the throw is the safety net); this ticket's contract is the inverse — **never rethrow** (the caller is a top-level try/catch and the loop must continue).
- `src/dispatch/prepareAgentSpawn.ts` (full file, 45 lines) — pattern for a `src/dispatch/` phase function: `(state: DispatchState, deps: Deps)` signature, dep-injected I/O surface, header comment that explains the seam. Mirror this layout.
- `src/github/labels.ts:25-49` — `GitHubLabelsClient.addLabel(number, name)` signature. `Pick<...>` this; the function body must not import the concrete class.
- `test/salvage/draft-pr.test.ts` (full file, 125 lines) — reuse the `fakeLabels({ onAdd })` helper pattern verbatim. The "addLabel throws" test there is the closest analogue to this ticket's "label-add throws but we still don't rethrow" assertion (inverted: salvage rethrows, this one swallows-and-logs).

## Context

Ticket #77 introduces a dispatcher orchestrator that runs each per-ticket dispatch inside a top-level `try { ... } catch (err) { await handleDispatchError(err, state, deps); }`. The `handleDispatchError` callee is split out here so it can land — with its own tests — before the orchestrator that consumes it.

The contract is narrow:

1. Tag the issue with `error:dispatch` so the run is observable in the GitHub UI.
2. Log the original error via an injected logger.
3. **Never rethrow.** A successful return tells the orchestrator "logged, move on; the loop continues with the next ticket."

`error:*` labels are dispatcher run-state metadata, not transition triggers. Per the existing carve-out in `src/pipeline/transitions.ts:37-41` (the `Label` union excludes `error:*`) and `src/pipeline/routing.ts:29` (`STRIP_PREFIXES` includes `"error:"`), `error:*` is exempt from the "all label mutations funnel through `decideLabelDelta`" rule. This phase therefore calls `addLabel` directly via injected deps — the same pattern `src/salvage/draft-pr.ts` already uses for `error:max_turns_salvaged`. The file header documents this and points to the source-of-truth comment.

## Design

### File layout

One new production file, one new test file. Net-new — no consumer call sites change in this ticket. (The orchestrator that wires this in is the follow-up; it will add `import { handleDispatchError } from "./handleDispatchError.ts"` inside `src/dispatch/` at that time.)

```
src/dispatch/handleDispatchError.ts        — new, ≤80 lines
test/dispatch/handleDispatchError.test.ts  — new
```

No barrel changes (CLAUDE.md: internal imports are direct). No edits to `src/pipeline/`, `src/github/`, `src/loop/`, or any sibling under `src/dispatch/`.

### Module header

The header comment **must** name three things, in this order:

1. The function's contract (catch-path callee, never rethrows, applies `error:dispatch`).
2. The `error:*`-bypasses-`decideLabelDelta` carve-out, with a literal reference to `src/pipeline/transitions.ts:38-41` (the comment block above the `Label` union). This satisfies the AC bullet on the header.
3. Pairing note: `src/pipeline/routing.ts:29` strips `error:*` on rework, so the label naturally clears when the next agent runs — no explicit cleanup needed here.

### Exports

```typescript
// src/dispatch/handleDispatchError.ts

export const DISPATCH_ERROR_LABEL = "error:dispatch";

export interface DispatchErrorLogger {
  // Single `error` sink. The function calls this with the caught error and
  // a small structured context payload. Mirrors a minimal subset of common
  // logger shapes; the launcher will bind a concrete implementation when
  // the orchestrator lands. Tests pass a fake that records calls.
  error(err: unknown, context: { readonly issueNumber: number; readonly agent: string; readonly phase: "dispatch" }): void;
}

export interface HandleDispatchErrorDeps {
  readonly labels: Pick<GitHubLabelsClient, "addLabel">;
  readonly logger: DispatchErrorLogger;
}

export async function handleDispatchError(
  error: unknown,
  state: DispatchState,
  deps: HandleDispatchErrorDeps,
): Promise<void>;
```

Imports: `import type { GitHubLabelsClient } from "../github/labels.ts";` (type-only — body never references the class) and `import type { DispatchState } from "./state.ts";`. Nothing else.

The `phase: "dispatch"` literal is fixed in the context payload so the logger can disambiguate dispatcher-side errors from other future error-path callees (e.g. a future `handleSalvageError`) without parsing the label string. Keeping it as a literal narrows the type and makes the call site self-describing.

### Function body — ordering and never-throw contract

```typescript
export async function handleDispatchError(
  error: unknown,
  state: DispatchState,
  deps: HandleDispatchErrorDeps,
): Promise<void> {
  // 1. Log the original error FIRST. The catch-path contract is that the
  //    logger receives the original error unconditionally — even if the
  //    label-add path below throws or never runs.
  deps.logger.error(error, {
    issueNumber: state.issueNumber,
    agent: state.agent,
    phase: "dispatch",
  });

  // 2. Apply the dispatch-error label. addLabel can throw (transport
  //    failure, GitHub API outage). We catch and log the secondary
  //    failure; the original error has already been recorded, and the
  //    loop must continue regardless.
  try {
    await deps.labels.addLabel(state.issueNumber, DISPATCH_ERROR_LABEL);
  } catch (labelErr) {
    deps.logger.error(labelErr, {
      issueNumber: state.issueNumber,
      agent: state.agent,
      phase: "dispatch",
    });
  }
}
```

**Why log-before-label rather than label-before-log:**

- The original error is the load-bearing observability. It must be captured whether or not GitHub is reachable.
- If the label-add succeeded but the logger came second and threw (it shouldn't, but the type allows it), we'd have an `error:dispatch` label on the issue with no log trail — worse than the inverse.
- If the logger throws, the function's "never rethrows" contract is technically violated. That's acceptable — a synchronous in-process logger that throws is an unrecoverable launcher-side bug, not a runtime failure mode this catch path is designed for. We do **not** wrap the logger call in try/catch (over-engineering; nothing observed to motivate it; CLAUDE.md "Don't write a defense for a failure mode that hasn't been observed").

**Why a try/catch around `addLabel` rather than `.catch()`:**

- Symmetry with the salvage module's commented prose: salvage's contract is "addLabel throws → propagate"; this ticket's is "addLabel throws → swallow-and-log". The try/catch is the visible inversion.
- `.catch()` would require an extra arrow-function allocation per call for no readability gain.

### What the function does NOT do

- It does **not** consult `decideLabelDelta` or any transition-table helper. The label is dispatcher state; the carve-out at `transitions.ts:38-41` is the documented exemption.
- It does **not** remove other labels. A run that errors out may legitimately carry `wip:<agent>` or `ready:<agent>`; their cleanup belongs to the next transition (which calls `decideReworkRouting`, which strips `error:*` along with `ready:*` and `wip:*`).
- It does **not** touch the worktree. Worktree teardown is a separate dispatcher-side concern and lands in a different phase.
- It does **not** mark the issue blocked or comment on it. The label alone is the marker. (Comment-on-error can be added later if observability demands it; not observed to be needed yet.)

## Concurrency model

Single async call (`addLabel`). No fan-out, no `AbortSignal`, no timers. The caller awaits the return; on resolution the orchestrator continues its loop. The function holds no state across calls — safe to call once per per-ticket dispatch attempt.

## Error handling

The error matrix the function handles internally:

| Caller's caught error | `addLabel` outcome           | Function behaviour                                                       |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| any `unknown`         | resolves                     | logger called once with original error; resolves void                    |
| any `unknown`         | throws (transport / 4xx/5xx) | logger called twice (original + label-add error); resolves void          |

The function never produces a rejected promise as long as `deps.logger.error` doesn't throw. That carve-out is intentional (see §"Why log-before-label").

## Testing strategy

Four unit tests in `test/dispatch/handleDispatchError.test.ts`. Reuse the `fakeLabels` helper pattern from `test/salvage/draft-pr.test.ts:9-18`; add a `fakeLogger` helper that captures `error(err, context)` calls.

Test fixtures: build a `makeState(overrides?)` factory analogous to `makeInput` in the salvage test — defaults to `{ agent: "developer", issueNumber: 88, worktreePath: "/tmp/wt", args: [] }`. The `worktreePath` and `args` are irrelevant to this function but required by `DispatchState`; the test factory keeps the noise out of each test body.

**Test 1 — happy path.** `addLabel` resolves. Assert: `labels.calls` contains exactly `[{ number: state.issueNumber, name: "error:dispatch" }]`; `logger.calls.length === 1`; `logger.calls[0].err` is the caught error (strict equality); `logger.calls[0].context` equals `{ issueNumber: state.issueNumber, agent: state.agent, phase: "dispatch" }`. The function resolves to `undefined`.

**Test 2 — `addLabel` throws → no rethrow; both errors logged in order.** Configure `fakeLabels({ onAdd: () => { throw new Error("HTTP 500"); } })`. Call `await handleDispatchError(original, state, deps)` — expect it to resolve (use `await expect(...).resolves.toBeUndefined()`, the `.resolves` form is the rethrow assertion). Assert: `logger.calls.length === 2`; `logger.calls[0].err === original`; `logger.calls[1].err.message === "HTTP 500"`. Pins both AC bullets ("does NOT rethrow" and "even when label-add throws").

**Test 3 — log-before-label ordering.** Reuse the salvage-test events-array trick: `fakeLogger` pushes `"log"`; `fakeLabels({ onAdd: () => { events.push("label"); } })` pushes `"label"`. Assert `events === ["log", "label"]` on the happy path. This pins §"Why log-before-label" against future reorderings.

**Test 4 — `DISPATCH_ERROR_LABEL` is exported as the literal string.** `expect(DISPATCH_ERROR_LABEL).toBe("error:dispatch")`. Mirrors the salvage test's final assertion at `draft-pr.test.ts:122-124`.

The four tests collectively pin every AC bullet that has a behavioural surface (the file-header and import-source bullets are static and can be eyeballed on commit).

## Acceptance-criteria → test/assertion mapping

| AC bullet                                                                                                    | Where it's pinned                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Function exported from `src/dispatch/`, takes `(error, state, deps)`, applies label via injected I/O         | Test 1 (asserts `labels.calls`)                                                            |
| Does NOT rethrow; successful return = "logged, move on"                                                      | Test 2 (`.resolves.toBeUndefined()`)                                                       |
| Logs underlying error via injected logger; no `console.*`                                                    | Test 1 (`logger.calls[0]`); manual review for `console.*` in body                          |
| Function body imports nothing from `src/github/`                                                             | `import type { GitHubLabelsClient }` only; type-only import is erased at compile time      |
| Header comment names the carve-out and points to `transitions.ts:38-41`                                      | Manual review on commit                                                                    |
| File under `src/dispatch/`, ≤100 lines                                                                       | File at `src/dispatch/handleDispatchError.ts`; design fits in ≤80 lines                    |
| Unit tests: label applied, no exception escapes, including label-add-throws path; logger receives the error  | Tests 1, 2                                                                                 |
| `pnpm typecheck && pnpm test` pass                                                                           | Run before commit                                                                          |

## Open questions

None. The contract, the import constraints, the label literal, and the deps shape are all fixed by the AC and the existing salvage analogue.
