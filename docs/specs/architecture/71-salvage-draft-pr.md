# Spec: `src/salvage/draft-pr.ts` — `openSalvageDraftPr` (#71)

Thin orchestration over the two dependencies (`GitHubLabelsClient.addLabel`,
`GitHubPrClient.createPr`). The whole module exists so the **ordering** —
label first, PR second — lives in a named, tested function rather than open-
coded at every salvage call site. Two `await`s, one returned PR number.

## Files to read first

- `src/github/labels.ts:41-47` — `addLabel(number, name): Promise<void>`. The contractual throw on transport failure is the load-bearing primitive this module relies on. **Top-of-file comment lines 7-15** explicitly call out this ticket's flow as the reason `addLabel` throws — do not catch it.
- `src/github/pr.ts:32-38` — `CreatePrInput { title, body, head, base, draft? }` shape the call site must satisfy. `draft: true` is the salvage path.
- `src/github/pr.ts:99-110` — `createPr(input): Promise<PrInfo>`. Returns `{ number, nodeId, url }`; this module forwards only `number`.
- `src/salvage/gate.ts` (entire file, 33 lines) — sibling shape precedent: small module, no barrel re-export, header comment under ~10 lines, exports are flat functions (no class), I/O dependencies arrive by parameter.
- `src/salvage/last-messages.ts` (entire file, 32 lines) — sibling under `src/salvage/`; same module shape; demonstrates the "import the dependency directly, don't wrap it" posture this module follows.
- `test/github/pr.test.ts:1-53` — `makeTransport(routes)` + `makeClient` helpers and the routing-table mock. Tests for `openSalvageDraftPr` should NOT spin up a real `GitHubPrClient`/`GitHubLabelsClient` — they should inject **fakes that satisfy the structural shape** of the two methods used. See § Testing strategy.
- `test/github/labels.test.ts:73-95` — the existing "transport-failure THROWS — load-bearing for the salvage flow's pre-PR labelling" assertion. This module's test suite is the **next layer up** of the same regression — pin that if `addLabel` throws, `createPr` is never reached.
- `test/salvage/gate.test.ts` and `test/salvage/last-messages.test.ts` — sibling test files; mirror their layout (vitest, `describe`/`it`, no `beforeEach`/`afterEach`, helper functions defined at the top of the file).
- `docs/specs/architecture/41-github-pr.md` § Context bullet 2 (2026-05-03 v1 lesson) and § "Module shape" — explains *why* `createPr` propagates transport errors verbatim and how the salvage flow consumes that posture. Do not re-fight this contract here.
- `docs/specs/architecture/36-github-labels.md` § "Why `addLabel` throws on transport failure" — the deterministic-safety-net rationale (CLAUDE.md § Belt-and-suspenders). This module is the **agent-side** of that pair; `labels.ts`'s throw is the **dispatcher-side** enforcement.
- `CLAUDE.md` § "One concern per file, hardcap 200 lines", § "Pure functions in `src/pipeline/`, I/O at the edges" (this file is an I/O edge — `src/salvage/` is correct, NOT `src/pipeline/`), § "Test-first" (RED before GREEN), § "Don't (no barrel imports inside `src/`)".

## Context

When a Claude agent run for issue #N exits with `max_turns` and the safe-salvage gate (`shouldAttemptSafeSalvage`, #69) returns `true`, the dispatcher wants to open a **draft PR** with the agent's partial work for human triage. Two operations must happen, in order:

1. **Apply `error:max_turns_salvaged` to the source issue #N.** This is the cross-cycle block: any future dispatcher iteration that scans the project board will see the label on issue #N and skip it (no second salvage attempt, no fresh agent run against the same in-progress ticket).
2. **Create the draft PR** from the agent's feature branch.

**The ordering is load-bearing.** If step 2 happens first and step 1 then fails transiently (GitHub REST hiccup, rate limit, network blip), the next dispatcher cycle observes:

- Issue #N **without** `error:max_turns_salvaged` → eligible for re-dispatch.
- Open PR exists on `feature/N` → the loop's PR-aware selection logic may treat it as a normally ready PR for the next stage (code review / auto-merge), or the rework path may dispatch another developer against the same branch.

Either branching is wrong — we wanted the operator to triage the half-finished draft, not let the dispatcher resume work as if nothing happened. The v1 lesson recorded on 2026-05-03 ("addLabel ordering before pr-create"): the safety primitive (label) must precede the artifact (PR). If labelling fails, **no PR exists yet** and the next cycle sees the original max_turns state — which is recoverable. If labelling succeeds but PR creation fails, the issue is blocked from re-dispatch, an operator notices, and the worst case is a manual cleanup — also recoverable. The only unrecoverable case is "PR exists, label doesn't" — and the ordering rules it out.

This module is the single function that pins that ordering in code, with a test that proves `createPr` is never reached when `addLabel` throws.

### What the label gates (and what it doesn't)

The label is applied to the **source issue**, not to the PR. The dispatcher's selection / re-dispatch logic keys on issue labels; the PR is a downstream artifact. A future ticket may also label the PR (for code-review-side filtering); that decision belongs to whichever module wires the salvage orchestrator, not here. The ticket body's framing "produce a PR that the next cycle treats as normally ready" is the **operational consequence** of an unlabeled source issue — the cycle re-dispatches against #N, finds the branch already has commits, and proceeds as if the PR were a normal in-flight one.

This module takes the issue number as input and does not assume `feature/N` ↔ `issue N`. The caller knows which issue is being salvaged and passes it explicitly.

## Design

### File: `src/salvage/draft-pr.ts`

One new file. Estimated 30–40 production lines including the header comment. Well under the 200-line hardcap.

#### Public surface

```ts
import type { GitHubLabelsClient } from "../github/labels.ts";
import type { CreatePrInput, GitHubPrClient } from "../github/pr.ts";

export const SALVAGE_LABEL = "error:max_turns_salvaged";

export interface SalvageDraftPrDeps {
  readonly labels: Pick<GitHubLabelsClient, "addLabel">;
  readonly pr: Pick<GitHubPrClient, "createPr">;
}

export interface OpenSalvageDraftPrInput {
  readonly issueNumber: number;   // source ticket — receives the label
  readonly title: string;
  readonly body: string;          // composed by composeLastMessagesSection (#70) + caller prelude
  readonly head: string;          // branch name, e.g. "feature/71"
  readonly base: string;          // target branch, e.g. "main"
}

export async function openSalvageDraftPr(
  deps: SalvageDraftPrDeps,
  input: OpenSalvageDraftPrInput,
): Promise<number>;
```

Design choices:

- **`SALVAGE_LABEL` exported as a named constant.** The string `"error:max_turns_salvaged"` is shared between this module, the dispatcher's pre-dispatch gate (which checks for it on the source issue and skips), and any future predicate-audit (CLAUDE.md § "Don't skip the predicate-audit pass when adding a new label or artifact variant"). Re-exporting prevents the string from drifting between consumers. The constant lives **here** rather than in `src/pipeline/transitions.ts` because the salvage label is an artifact-class label produced exclusively by this module — the transition table tracks status-class labels that the pipeline's pure decision functions mutate. If a second salvage producer ever exists, hoist then.
- **`Pick<...>` for the deps types**, not the full client interfaces. The function uses one method from each; declaring a structurally-minimal dependency surface (a) lets tests inject one-method fakes without reaching for the routing-table transport mock, and (b) documents at the type level that this module needs no other capability from either client. Same idea as #69's injected `GateRunner` — the seam is sized to what the function actually uses.
- **Deps as the first argument, input as the second.** Mirrors the `(GateRunner, gates)` arg-order convention #69 used (well, technically `(gates, run)` there — but here the deps object is the "wiring" and the input is "data," and deps-first matches the broader codebase's DI shape, e.g. `GitHubProjectClient.initialize(opts, transport)`). The orchestrator will likely bind deps once and call this function many times with different inputs.
- **Returns the PR number alone, not the full `PrInfo`.** AC says "returns the new PR number." The caller doesn't yet need `nodeId` or `url`. If a later consumer does, widen the return type then — adding a field is non-breaking; narrowing isn't. (Same posture as #41's `enableAutoMerge` returning `void` rather than the resolved node ID it had to compute internally.)
- **No `OpenSalvageDraftPrResult` struct.** A bare `number` is the right shape until there's a second field worth bundling. Premature struct = #41's "no `MergeOptions` until two callers" posture, applied here.
- **No `draft` parameter on the input type.** Salvage is *always* a draft PR. Exposing `draft` would let a future caller open a non-draft salvage PR, which is meaningless. The constant `draft: true` is set inline in the implementation.

#### Implementation

```ts
export async function openSalvageDraftPr(
  deps: SalvageDraftPrDeps,
  input: OpenSalvageDraftPrInput,
): Promise<number> {
  await deps.labels.addLabel(input.issueNumber, SALVAGE_LABEL);

  const createInput: CreatePrInput = {
    title: input.title,
    body: input.body,
    head: input.head,
    base: input.base,
    draft: true,
  };
  const pr = await deps.pr.createPr(createInput);
  return pr.number;
}
```

Eleven lines of body. No try/catch. No fallback. No defensive null checks (`addLabel` throws or resolves; if it resolves, the second `await` runs unconditionally; if it throws, the second `await` is unreachable — which is the AC's exact contract).

#### Why no try/catch around `addLabel`

The AC bullet "No try/catch swallows the addLabel failure — the throw bubbles up per #36's contract" is the entire reason `addLabel` throws in the first place. Wrapping it would defeat the deterministic-safety-net property: the label-throw is the only signal the orchestrator has that the labelling failed, and the only thing standing between "we tried to salvage" and "we shipped a confused state." Treat the absence of try/catch as a load-bearing implementation detail and pin it with a test (see § Testing strategy).

`CLAUDE.md` § Belt-and-suspenders applies directly: this function is the **agent-side rule** ("label first, then PR"); `labels.ts:45`'s throw is the **deterministic dispatcher-side enforcement**. Both must exist for the safety net to work; both already do — this module just composes them.

#### Why no try/catch around `createPr` either

If `createPr` throws after `addLabel` succeeded, the source issue is now labeled but no PR exists. The dispatcher's next cycle will see the labeled issue and skip it (no re-dispatch). An operator notices a stuck issue, looks at logs, runs whatever recovery is appropriate. The function rethrows — this module does not own recovery, the orchestrator does. Same posture as #41's "errors propagate verbatim."

### Header comment (top of file)

~10 lines, in the tone of `gate.ts:1-9` and `last-messages.ts:1-8`. Mention:

- This module pins the **load-bearing order**: label first, PR second. The order is the entire point of the function.
- `addLabel` throws on transport failure (per #36); this module does not catch — the throw is the safety net.
- The label is applied to the **source issue**, not the PR. The PR doesn't exist yet at the call site.
- `draft: true` is constant; salvage PRs are always drafts.

Keep it operational, not historical. Cross-reference #36 once; do not re-litigate the v1 lesson.

### Module-shape rules

- No barrel re-export (CLAUDE.md § Don't). Internal imports are direct.
- Imports use the `.ts` extension (matches every other file in the repo).
- One concern: "open a salvage draft PR with the label applied first." No status mutation, no project-board updates, no JSONL composition (that's #70).

## Concurrency model

None. Two sequential `await`s on injected I/O methods. No `Promise.all`, no `AbortSignal` (the caller owns wall-clock budgeting; this function is one-shot). The orchestrator that calls this function will handle cancellation if needed by aborting before invocation — there is no useful cancellation point between the label and the PR (cancelling between them is precisely the failure mode the ordering exists to rule out).

## Error handling

- **`addLabel` resolves** → proceed to `createPr`.
- **`addLabel` throws** → rethrow verbatim. `createPr` is never invoked. No log, no rewrite, no retry.
- **`createPr` resolves** → return `pr.number`.
- **`createPr` throws** → rethrow verbatim. Source issue is labeled but no PR exists; this is the second-best outcome per § Context and is recoverable by the operator.

No `try`/`catch` anywhere in this file. No `finally`. No `.catch(() => ...)`. The implementation is two awaits and a return.

If a future ticket adds telemetry around salvage failures, that wiring belongs at the orchestrator, where the broader recovery context is available (which agent's run, which JSONL path, which gate verdict). This module stays a pure ordering primitive.

## Testing strategy

`test/salvage/draft-pr.test.ts` — vitest, RED-first. Mirrors the sibling test files (`test/salvage/gate.test.ts`, `test/salvage/last-messages.test.ts`).

### Why structural fakes, not the routing-table transport mock

The function only touches `labels.addLabel(number, name)` and `pr.createPr(input)`. Routing tables through GraphQL/REST transports add two layers of indirection (transport call sequence, mutation/query string matching) that the test isn't actually trying to pin — those are #36 and #41's territory. Instead, declare two recording fakes that satisfy `Pick<GitHubLabelsClient, "addLabel">` and `Pick<GitHubPrClient, "createPr">`. The fakes record their calls; the test asserts on the recorded sequence.

Suggested helpers (top of the test file):

```ts
function fakeLabels(behavior?: { onAdd?: (n: number, name: string) => void | Promise<void> }) {
  const calls: Array<{ number: number; name: string }> = [];
  const addLabel = async (number: number, name: string) => {
    calls.push({ number, name });
    if (behavior?.onAdd) await behavior.onAdd(number, name);
  };
  return { calls, client: { addLabel } };
}

function fakePr(behavior?: {
  onCreate?: (input: CreatePrInput) => void | Promise<void>;
  number?: number;
}) {
  const calls: CreatePrInput[] = [];
  const createPr = async (input: CreatePrInput) => {
    calls.push(input);
    if (behavior?.onCreate) await behavior.onCreate(input);
    return {
      number: behavior?.number ?? 42,
      nodeId: "PR_kw1",
      url: `https://github.com/pyrycode/v2/pull/${behavior?.number ?? 42}`,
    };
  };
  return { calls, client: { createPr } };
}
```

These satisfy the `Pick<...>` interfaces structurally. No `instanceof` check anywhere in `draft-pr.ts` rules them out.

### Test groups

One `describe("openSalvageDraftPr")` block. Within it:

1. **Happy path — label call succeeds → PR created as draft → returns PR number** (AC bullet 4):
   - Both fakes succeed. `fakePr({ number: 137 })`.
   - Assert: returned value equals `137`.
   - Assert: `labels.calls` equals `[{ number: 71, name: "error:max_turns_salvaged" }]`.
   - Assert: `pr.calls.length === 1`.
   - Assert: `pr.calls[0]` equals `{ title, body, head, base, draft: true }` exactly (deep-equals, locks the wire shape including `draft: true`).
   - This single test pins three ACs: returns PR number; PR is draft; label name string.

2. **Load-bearing ordering — addLabel called before createPr** (AC bullet 2):
   - Use a shared `events: string[]` array. Both fakes push `"label"` and `"create"` respectively into the array.
   - After `openSalvageDraftPr`, assert `events` equals `["label", "create"]` (in that exact order).
   - This catches a future refactor that runs them in parallel via `Promise.all` (which would non-deterministically interleave) or swaps the order.

3. **addLabel throws → createPr is never invoked, openSalvageDraftPr rethrows** (AC bullet 3 — explicitly required by the AC: *"verified by an integration test that injects a throwing label client"*):
   - `fakeLabels({ onAdd: () => { throw new Error("HTTP 500: label failed"); } })`.
   - `fakePr()` (records but should never be called).
   - Wrap the call in `try`/`catch` (or use vitest's `await expect(...).rejects.toThrow(...)`).
   - Assert: caught error message contains `"HTTP 500: label failed"`.
   - Assert: `pr.calls.length === 0` — **load-bearing**. This is the regression pin.
   - Assert: `labels.calls.length === 1` — the one failed call.

4. **createPr throws after addLabel succeeded → openSalvageDraftPr rethrows; label call still happened** (recovery-shape test):
   - `fakeLabels()` succeeds.
   - `fakePr({ onCreate: () => { throw new Error("HTTP 500: pr failed"); } })`.
   - Assert: rejects with the `pr failed` message.
   - Assert: `labels.calls.length === 1` (the label DID get applied — the source issue is now blocked from re-dispatch, which is the recoverable state per § Error handling).
   - This isn't in the AC verbatim but pins the § Error handling contract that the function does NOT try to roll back the label on a createPr failure.

5. **No try/catch swallowing** (AC bullet 5 — indirect, but pinned via test 3):
   - Already covered by test 3's "openSalvageDraftPr rethrows" assertion. The negative shape (try/catch swallowing → no throw → no failed assertion) is what test 3 rules out. Mention this in a comment on test 3 so a future reader doesn't add a sixth test for the same property.

### Implementation order (RED → GREEN, per CLAUDE.md § Test-first)

1. Write `test/salvage/draft-pr.test.ts` with the four `it` cases above. Run `pnpm test` → fails (source file does not exist). RED.
2. Write `src/salvage/draft-pr.ts` per § Design. Run `pnpm test` → passes. GREEN.
3. Run `pnpm typecheck && pnpm lint` — both pass. (`pnpm typecheck` will catch a mistake like forgetting `draft: true` because `CreatePrInput.draft` is `boolean | undefined`, not strict; that risk is on the test's deep-equals shape pin.)
4. Commit spec + source + tests together.

### Files touched

- `src/salvage/draft-pr.ts` — new, ~30–40 lines (header comment ~10, body ~15, types ~10–15).
- `test/salvage/draft-pr.test.ts` — new, ~100–130 lines (test files don't pay the production cap).

No edits to existing files. No `src/index.ts` re-export. No changes to `labels.ts`, `pr.ts`, `gate.ts`, or `last-messages.ts`.

## Size & scope

- **Production lines (estimate):** ~30–40 across one new file.
- **Files touched:** 2 new, 0 modified.
- **New exported symbols:** 1 constant (`SALVAGE_LABEL`), 2 interfaces (`SalvageDraftPrDeps`, `OpenSalvageDraftPrInput`), 1 function (`openSalvageDraftPr`). Total: 4. Under the 5-new-exported-types red line.
- **Consumer call sites:** 0 (the salvage orchestrator is a future ticket).
- **AC count:** 5 — equal to the red line, but each AC maps to a small implementation slice and they're all pinned by 4 tests (one test covers multiple ACs). No edit fan-out.
- **Edit fan-out (codegraph_impact check):** N/A — net-new symbols.
- **Verdict:** Solid S. No red lines tripped. Could arguably be XS (production code ≪ 100 lines, no consumer cascade), but the ordering contract + four-test pinning is worth the S budget rather than crowding XS.

## Open questions

1. **Should the salvage label also be applied to the PR after creation?** Out of scope for this ticket. The AC scopes labelling to the source issue (the safety primitive that gates the next dispatch cycle). A later orchestrator ticket may decide to also label the PR for code-review-side filtering — that decision needs evidence that the dispatcher's PR-selection logic *would* otherwise treat the salvage PR as normally ready, which depends on `findReadyPrNumber` (#42) and the auto-merge loop. Don't preempt.

2. **`title` defaulting / generation.** This module takes `title` as required input. The salvage orchestrator will compose a title like `"[salvage] feature/71: max_turns at turn 50"` — but the exact wording is a UX call that belongs to the orchestrator (where the agent name, run id, and turn count are available). Hardcoding a title here would be premature.

3. **What does the orchestrator pass as `body`?** Per ticket body Technical Notes, the body is composed by `composeLastMessagesSection` (#70) — likely a short prelude (which agent, what branch, what gate verdict) followed by the section that #70 produces. The composition lives at the orchestrator, not here. This module is shape-agnostic about `body`.

## Out of scope (explicit non-goals)

- Wiring `openSalvageDraftPr` into a salvage orchestrator. The orchestrator (a later ticket) will compose this module with #69 (gate), #70 (last-messages section), the JSONL discovery layer (sibling ticket), and the dispatcher loop.
- Labelling the PR after creation. See Open Question 1.
- Title or body composition. The caller passes them already-composed.
- Rolling back the label if `createPr` fails. See § Error handling — out of scope, belongs to the orchestrator.
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" forbids barrel re-exports inside `src/`.
- Telemetry / logging. Belongs at the orchestrator where context is available.
- Parameterising `draft`. Salvage PRs are always drafts; see § Design.

## Implementation checklist (for the developer)

1. Create `test/salvage/draft-pr.test.ts` first with the four cases per § Testing strategy. Lift the structural-fake helpers verbatim from this spec. Run `pnpm test` to confirm RED.
2. Create `src/salvage/draft-pr.ts` with the surface in § Design. Header comment ~10 lines, body ~15, types as written.
3. Run `pnpm typecheck && pnpm test && pnpm lint` — all green.
4. No barrel, no re-exports elsewhere, no edits to any file outside `src/salvage/draft-pr.ts` and `test/salvage/draft-pr.test.ts`.
5. Commit (the spec is already committed by the architect run; commit the source + tests in one commit).
