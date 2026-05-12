# Spec: `src/pipeline/classifyAgentResult` — post-run result classifier (#86)

## Files to read first

- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — this file is the canonical fit for the rule; lift no I/O into the function body
- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — the file will land at ~20 lines, well under
- `CLAUDE.md` § "Test-first" — RED → GREEN; assertions before the function body
- `CLAUDE.md` § "Don't" — bullets "Don't write a defense for a failure mode that hasn't been observed" (constrains the discriminant width — keep the union at two members) and "Don't import from a barrel file" (no `src/index.ts` re-export)
- `src/claude/stream.ts:16-28` — `ExitReason` (`"success" | "max_turns" | "rate_limit" | "error"`) and `StreamParseResult` shape; this is the input contract
- `src/pipeline/routing.ts:1-48` — closest sibling: a tiny pure pipeline function over a closed string union returning a typed discriminant. Mirror its top-of-file comment style and `export type` + `export function` ordering. **Do not** mirror its `Record<…, …>` mapping pattern — that fits a 4-key fan-out, this function is a 1-vs-N split and reads better as a single conditional
- `test/pipeline/routing.test.ts:1-50` — vitest pattern: `import` from `../../src/pipeline/…`, `.ts` extension preserved, one `describe` per export, `it.each` for table-driven row coverage
- `test/claude/stream.test.ts:1-40` — vitest import style + assertion shape used elsewhere on `StreamParseResult`-flavoured tests (helpful to keep the test imports symmetric)
- `biome.json:5-19` — formatter rules (double quotes, trailing commas all, semicolons always, 100-col)
- `package.json:11-18` — CI gate commands the AC implicitly invokes (`pnpm typecheck && pnpm test`)

## Context

After `spawnClaude` (`src/claude/spawn.ts:60`) returns a `StreamParseResult`, the post-spawn orchestrator (next ticket from the #77 split) needs to branch on whether the agent finished cleanly or in an error state. Inlining `result.exitReason === "success"` into the orchestrator works but bleeds two pieces of policy into the caller:

1. *Which* exit reasons count as "cleanly finished" (today: `success` only).
2. *Which* count as agent-side errors the dispatcher should label and route (today: `max_turns`, `rate_limit`, `error`).

Lifting the rule into a named pure function makes "what counts as an error" unit-testable on its own and gives the orchestrator a stable surface to switch on. The classifier is the pure half of post-run; the impure half (apply the `error:*` label via `decideLabelDelta`, release `wip:*`, etc.) is the orchestrator's job — see #77's other split children for the post-run dispatch glue.

Out of scope (explicit non-goals — restating the ticket body for the implementer):

- **Rework detection** from `needs-rework:*` labels — already lives in `decideReworkRouting` (`src/pipeline/routing.ts:31`). Different input (labels, not stream artifacts), different decision (which agent to re-run), different output (`ReworkRouting`). The orchestrator threads both classifiers; this ticket does not combine them.
- **Mapping the agent-error subcategories** (max_turns vs rate_limit vs error) to specific `error:*` labels. That's the label-delta phase's job (#77 → `decideLabelDelta` + transitions table). The classifier returns a binary signal; the orchestrator reads `result.exitReason` directly when it needs the finer-grained reason for labeling.

## Design

### File: `src/pipeline/classifyAgentResult.ts`

One new file. One exported function, one exported type. Estimated ~20 production lines; under the 200-line hardcap with room to spare.

#### Public types

```ts
// Closed binary discriminant for post-run branching. Two members today:
//   - "ok"           — agent finished cleanly; orchestrator advances the
//                      ticket to the next pipeline column per transitions.ts
//   - "agent-error"  — agent terminated abnormally (max turns, rate limit,
//                      crash, dispatcher timeout — anything that left the
//                      stream without a "success" result message); the
//                      orchestrator tags the issue and stops advancement
//
// Why a string union (not a discriminated object carrying the underlying
// ExitReason): the orchestrator already has the StreamParseResult in scope
// and can read `result.exitReason` directly when it needs the finer-grained
// reason (e.g. choosing between `error:max-turns` and `error:rate-limit`).
// Keeping this union narrow follows CLAUDE.md "Don't write a defense for a
// failure mode that hasn't been observed" — widening to e.g. add a separate
// "rate-limit" class is a code change for the first observed need, not a
// speculative shape today.
export type AgentResultClass = "ok" | "agent-error";
```

#### Entry point

```ts
import type { StreamParseResult } from "../claude/stream.ts";

export function classifyAgentResult(result: StreamParseResult): AgentResultClass {
  return result.exitReason === "success" ? "ok" : "agent-error";
}
```

Pure: no `await`, no `gh` / `git` / `fs` / `process.env`, no shared state. POJO in, string out.

**Why a single conditional** rather than a `Record<ExitReason, AgentResultClass>` mapping like routing.ts uses for its `AGENT_TO_COLUMN`: the mapping is 1-vs-N (one ok value, all others error). A `Record` would either repeat `"agent-error"` three times — a regression-magnet shape because adding a new `ExitReason` member silently falls through unless every site is touched — or use a single conditional anyway. The conditional reads more clearly and stays correct under union widening (if a future ticket adds `"timeout"` to `ExitReason`, it falls through to `"agent-error"` automatically, which is the desired conservative default for an unknown new failure mode).

Mapping table for the implementer's reference (same content, different shape — do not encode this as a `Record`):

| `result.exitReason` | `classifyAgentResult(result)` |
|---|---|
| `"success"`     | `"ok"`           |
| `"max_turns"`   | `"agent-error"`  |
| `"rate_limit"`  | `"agent-error"`  |
| `"error"`       | `"agent-error"`  |

#### Top-of-file comment

Mirror routing.ts's comment shape: one paragraph stating the contract ("pure classifier over a parsed agent run; no I/O"), one paragraph stating what's *not* here (rework detection — point at `decideReworkRouting`; error-label mapping — point at `decideLabelDelta`). Three to six lines total; do not duplicate the spec's full Context section.

### File: `test/pipeline/classifyAgentResult.test.ts`

Mirrors the source path. Vitest, RED-first.

Required test rows (mapping to the AC bullet "Unit tests cover the happy `success` → `"ok"` case and at least one of `error` / `max_turns` / `rate_limit` → `"agent-error"`"):

1. **Happy path**: `exitReason: "success"` → `"ok"`. One `it`.
2. **Agent-error path — table-driven**: use `it.each` over `["max_turns", "rate_limit", "error"]` asserting each maps to `"agent-error"`. The AC asks for "at least one"; covering all three with `it.each` is two lines longer than picking one and prevents the silent-regression case where someone refactors the conditional and only the spot-checked branch stays green.

For test fixtures, **do not** load JSONL — `classifyAgentResult` operates on the already-parsed `StreamParseResult`, not the raw stream. Build the input inline as a typed object literal. The minimum-shape input is:

```ts
function fakeResult(exitReason: ExitReason): StreamParseResult {
  return {
    totalCostUsd: 0,
    sessionId: undefined,
    lastAssistantMessage: undefined,
    lastNAssistantMessages: [],
    exitReason,
  };
}
```

Place this helper inside the test file (not in `test/fixtures/`) — it's a one-off, three callers, no reuse across files. The other `StreamParseResult` fields are not read by the classifier and exist only to satisfy the type contract; the test stays honest by populating them with the trivial empty / zero values rather than mocking.

**Structural-invariant note**: do not add an `it` that re-exports `ExitReason` and asserts every member is covered — TypeScript already enforces exhaustiveness at the call site via the string-literal check. The four-row `it.each` (1 success + 3 error rows) IS the structural invariant; widening `ExitReason` will leave the new value uncovered in the test, which is the right RED signal.

### Files touched

- `src/pipeline/classifyAgentResult.ts` — new, ~20 lines
- `test/pipeline/classifyAgentResult.test.ts` — new, ~30 lines

No edits to existing files. No `src/index.ts` re-export. No new fixtures.

### Implementation order (RED → GREEN, per `CLAUDE.md` § Test-first)

1. Write `test/pipeline/classifyAgentResult.test.ts` with both `describe` blocks and all four `it` rows. Run `pnpm test` → fails (file does not exist). RED.
2. Write `src/pipeline/classifyAgentResult.ts`. Run `pnpm test` → passes. GREEN.
3. Run `pnpm typecheck && pnpm lint` → both pass.
4. Commit spec + source + tests together (single commit, single feature).

## Concurrency model

None. Pure synchronous function over a frozen struct. The whole point of pushing this into a pure shape is that there's nothing to coordinate.

## Error handling

- **No throws**: the function cannot throw on any well-typed input. The closed `ExitReason` union guarantees the conditional terminates without a `default` branch.
- **Unknown `exitReason` values** (e.g. a future SDK adds `"timeout"` and the `ExitReason` union is widened without updating this function): the conditional falls through to `"agent-error"`. This is the conservative default — an unknown new failure mode should be treated as an error, not silently passed as ok. The follow-up ticket that widens `ExitReason` will write the test row that pins the new branch's behaviour.
- **No fallbacks** for malformed `StreamParseResult` inputs. The parser (`parseStream`, `src/claude/stream.ts:34`) is the single producer; it always returns a well-typed struct. The classifier trusts its input — per CLAUDE.md, validation lives at system boundaries, not between pure pipeline functions.

## Testing strategy

The `it.each` table over `["max_turns", "rate_limit", "error"]` is the load-bearing surface. Each row is one line; together they prevent the regression where someone refactors `=== "success"` into a positive-list and forgets one of the negative cases. The happy-path `it` pins the single positive mapping.

Per CLAUDE.md "Test-first": write the assertions before the function body. There is no way to "TDD this wrong" — the function is one expression — but the discipline matters for the next architect spec that references this one as prior art.

CI gate: `pnpm typecheck && pnpm test` (already wired up by #1).

## Open questions

1. **Function name.** Spec uses `classifyAgentResult` (matches the ticket body's example). Alternatives considered: `classifyRunOutcome`, `agentResultClass`, `isAgentError`. Rejected `isAgentError` because the boolean predicate shape loses the explicit "ok" symbol and forces the caller to invert at the call site; the string-union shape keeps the orchestrator's `switch` / ternary readable. Recommendation: ship as `classifyAgentResult`. If the orchestrator ticket prefers a different name, rename here — caller-driven naming for a single-call-site function.

2. **Discriminant member naming: `"agent-error"` vs `"error"`.** `"agent-error"` makes the boundary against `error:dispatch` (dispatcher-side failures, #77's `handleDispatchError`) explicit at the type level — the classifier returns the *agent* class, the dispatch-error path is a separate concern. Plain `"error"` would collide semantically with that other axis. Recommendation: ship as `"agent-error"`.

## Out of scope (explicit non-goals)

- Carrying the underlying `ExitReason` on the agent-error branch (e.g. `{ kind: "agent-error", reason: ExitReason }`). The orchestrator still has the `StreamParseResult` in scope and reads `result.exitReason` directly when it needs the finer reason for `error:*` labeling. Adding the payload here forces every caller to destructure it whether they care or not — premature shape.
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" bullet explicitly forbids barrel re-exports inside `src/`.
- A `Record<ExitReason, AgentResultClass>` mapping. Discussed under § Design; the 1-vs-N shape reads better as a single conditional and keeps the "unknown new exit reason → agent-error" fall-through behaviour automatic.
- Combining stream-derived classification with label-derived rework detection. They are two pure functions over two different inputs, called by the orchestrator in sequence. Combining them would force a fake shared input type and bury two unrelated decisions in one function.
- Wiring `classifyAgentResult` into the post-spawn orchestrator. That's a downstream ticket from the #77 split; this ticket lands the classifier alone.
