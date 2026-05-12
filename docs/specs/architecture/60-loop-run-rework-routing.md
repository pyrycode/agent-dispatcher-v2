# Spec — `src/loop/runReworkRouting.ts` (`runReworkRouting`)

Ticket: #60 — Land `src/loop/runReworkRouting.ts` — route `needs-rework:*` tickets back upstream.

## Files to read first

- `src/pipeline/routing.ts` (full, 49 lines) — `decideReworkRouting` returns `{ target: Agent | null, stripLabels: readonly string[] }`. `Agent` is `ExtractAgent<Label>` = `"po" | "architect" | "developer" | "code-review"` (no `documentation` — there is no `needs-rework:documentation` label). The new `targetColumnForAgent` export lands in this file, beside `decideReworkRouting`.
- `src/pipeline/transitions.ts:14-21` — `Column` union. The four target columns the new mapping yields are `Backlog`, `In Architecture`, `In Development`, `In Code Review`. Transitions.ts:99-177 also encodes the same agent→column mapping implicitly in the rework rows (`needs-rework:po` → `to: "Backlog"`, etc.); the new mapping just lifts it out so the runner doesn't re-derive it.
- `src/loop/runDoneCleanup.ts` (full, 53 lines) — the sibling this runner mirrors **exactly** in shape: top-of-file architectural comment, narrow `*Item` / `*Deps` types co-located, single exported async function, sequential `for...of` with per-item `await`, no try/catch, no `src/github/` imports. The structure of `runReworkRouting` must read as a near-clone with three port methods instead of two.
- `test/loop/runDoneCleanup.test.ts` (full, 81 lines) — the test idiom to mirror: `makeRecorder(items)` returning `{ deps, removals, listCalls, ... }` with hand-rolled fakes for each port. The new test extends this with a `statusChanges` recorder for the `setItemStatus` mutator.
- `test/pipeline/routing.test.ts` (full, 87 lines) — extend with one `describe("targetColumnForAgent", …)` block covering all four `Agent` values. The existing `REWORK_LABELS` constant is the exhaustive list to iterate.
- `src/github/project-client.ts:24-35, 137-149` — `ProjectItem` shape (`id`, `issueNumber`, `title`, `status`, `labels`, `url`, `state`) and the production `setItemStatus(itemId, statusName)` signature. The runner reads `itemId` (NOT `issueNumber`) when setting status — `setItemStatus` keys on the GraphQL node id, not the issue number. `removeLabel`, in contrast, keys on `issueNumber`. Mixing these up is the one easy mistake.
- `src/github/labels.ts:54-58` — `removeLabel`'s GET-then-PUT-only-if-present idempotency. Second idempotency layer below the AC's "no calls when there's nothing to do" gate.
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — `targetColumnForAgent` must be pure (no `await` / `gh` / `git` / `fs`); the runner under `src/loop/` is the I/O edge.
- `CLAUDE.md` § "decideLabelDelta is the only place labels mutate" — `decideReworkRouting` is a peer label-mutation decider (per the comment in routing.ts:9-13: `wip:*` / `error:*` aren't in transitions.ts's strip patterns, so the rework-routing decision owns them). The runner consumes its `stripLabels` verbatim and does NOT re-derive prefix matching.
- `CLAUDE.md` § "Belt-and-suspenders" — this runner IS the deterministic safety net for the stochastic "agent adds `needs-rework:*`" rule. Idempotency is the load-bearing property; AC pins it explicitly.
- `CLAUDE.md` § "Test-first" — RED → GREEN. Write the `targetColumnForAgent` test cases and the runner test file first, watch them fail, then implement.

## Context

Any agent in the pipeline can route work back upstream by adding `needs-rework:<target>`. Per `decideReworkRouting`, that signal carries two pieces of information:

1. **Where to send it.** The `target` field (an `Agent`) names the agent whose column the ticket belongs in.
2. **What stale state to clear.** The `stripLabels` field is the set of `ready:* | wip:* | error:*` labels currently on the ticket, with the triggering `needs-rework:*` label deliberately excluded.

This runner is the deterministic I/O side that applies both: each cycle it iterates project items, calls `decideReworkRouting(item.labels)`, and — when `target` is non-null — strips every label in `stripLabels` then sets the ticket's project Status to `targetColumnForAgent(target)`. The triggering `needs-rework:*` label is left in place; the target agent's own run is what consumes (and eventually replaces) it.

This is one of four per-cycle maintenance routines on top of `src/pipeline/` decisions and `src/github/` primitives — siblings: `runDoneCleanup` (#57, landed), `runClosedSweep` (#58), `runAutoMerge` (#59, landed). All four share the same DI shape: narrow port interfaces, no whole-client dependencies, hand-rolled test fakes.

### Why a new `targetColumnForAgent` export instead of branching in the runner

The mapping (`po → Backlog`, `architect → In Architecture`, `developer → In Development`, `code-review → In Code Review`) is implicit in the TRANSITIONS table's rework rows. Two reasons to lift it into a named pure function in `routing.ts`:

- **Purity rule.** Per CLAUDE.md, label/transition decisions live in `src/pipeline/`. The runner under `src/loop/` is an I/O orchestrator; a `switch (target) { case "po": ... }` inside it would smuggle a pipeline decision into the I/O layer.
- **Exhaustiveness.** A `Record<Agent, Column>` literal forces a TypeScript error the moment a new `Agent` member appears (e.g. if `needs-rework:documentation` is ever added to `Label`). A `switch` with a fall-through default would silently route the new agent to the wrong column. Same single-source-of-truth posture as the `Label` / `Agent` derivation already in routing.ts:20.

## Design

### Change 1 — `src/pipeline/routing.ts`: add `targetColumnForAgent`

Append to the existing file (does not touch `decideReworkRouting` or `Agent`):

```ts
import type { Column } from "./transitions.ts";

// Agent → Column the dispatcher routes the ticket back to when this agent
// is the target of a needs-rework signal. Implicit today in the rework rows
// of TRANSITIONS (see transitions.ts:99-177); lifted into a named mapping
// so the loop runner doesn't re-derive it and so adding a new Agent member
// is a TS error here (Record exhaustiveness) instead of a silent miss-route.
const AGENT_TO_COLUMN: Record<Agent, Column> = {
  po: "Backlog",
  architect: "In Architecture",
  developer: "In Development",
  "code-review": "In Code Review",
};

export function targetColumnForAgent(agent: Agent): Column {
  return AGENT_TO_COLUMN[agent];
}
```

Notes:

- `Record<Agent, Column>` is the load-bearing typing. A bare `Record<string, Column>` or a `switch` defeats the point. Do not narrow `Column` further with a sub-union — the function returns one of four values today, but typing the return as `Column` keeps the call site's `setItemStatus(itemId, columnName)` shape uniform with the rest of the codebase.
- `documentation` is NOT in `Agent` (it has no `needs-rework:documentation` label per transitions.ts:48-51), so it is correctly absent from this mapping. If a future ticket adds `needs-rework:documentation`, `Agent` widens automatically (it's derived from `Label`), TS flags the missing key, and the developer for that ticket adds the row. Do not pre-emptively add a `documentation: "In Documentation"` row "just in case" — that's defending against an unobserved failure mode (CLAUDE.md § "Don't write a defense for a failure mode that hasn't been observed").
- Internal `AGENT_TO_COLUMN` constant is not exported. Only the function. Same encapsulation as the existing `REWORK_PREFIX` / `STRIP_PREFIXES` constants in the file.

### Change 2 — `src/loop/runReworkRouting.ts`: new file

```ts
// Per-cycle maintenance routine: route needs-rework:<agent> tickets back
// to the target agent's column and strip stale ready:* / wip:* / error:*
// labels so the target runs on a clean slate. The triggering
// needs-rework:* label is left in place — the target agent's run consumes
// it.
//
// Belt-and-suspenders: the agent that added the needs-rework:* label is
// the stochastic part; this runner is the deterministic safety net that
// makes the routing actually happen. Per CLAUDE.md "decideLabelDelta is
// the only place labels mutate" the strip set is computed by the pure
// decideReworkRouting in src/pipeline/routing.ts; this file does NOT
// branch on label names.
//
// Idempotency is structural in two ways:
//   1. No needs-rework:* on the item → decideReworkRouting returns
//      target=null; the runner continues to the next item without
//      reading status or calling any mutator.
//   2. needs-rework:* present but already in the right column with no
//      stale labels → decideReworkRouting's stripLabels is empty and the
//      target-column check below skips setItemStatus. Zero mutations.
// Below those gates, removeLabel itself is GET-then-PUT-only-if-present
// (src/github/labels.ts) — a third layer that costs at most a single GET
// per accidentally-repeated strip.

import { decideReworkRouting, targetColumnForAgent } from "../pipeline/routing.ts";

// Narrow ports — only the methods this runner actually calls. NOT
// GitHubProjectClient / GitHubLabelsClient as a whole. Production wiring
// passes `client.listItemsInBoardOrder.bind(client)` etc.; tests hand-roll
// fakes (see test/loop/runReworkRouting.test.ts).
export interface ReworkRoutingItem {
  readonly itemId: string;
  readonly issueNumber: number;
  readonly status: string;
  readonly labels: readonly string[];
}

export interface ReworkRoutingDeps {
  readonly listItems: () => Promise<readonly ReworkRoutingItem[]>;
  readonly removeLabel: (number: number, name: string) => Promise<void>;
  readonly setItemStatus: (itemId: string, statusName: string) => Promise<void>;
}

export async function runReworkRouting(deps: ReworkRoutingDeps): Promise<void> {
  const items = await deps.listItems();
  for (const item of items) {
    const { target, stripLabels } = decideReworkRouting(item.labels);
    if (target === null) continue;

    for (const name of stripLabels) {
      await deps.removeLabel(item.issueNumber, name);
    }

    const targetColumn = targetColumnForAgent(target);
    if (item.status !== targetColumn) {
      await deps.setItemStatus(item.itemId, targetColumn);
    }
  }
}
```

### `ReworkRoutingItem` vs `DoneCleanupItem` — why an extra field

`runDoneCleanup`'s item carries `issueNumber`, `status`, `labels`. `runReworkRouting` additionally needs `itemId` because `setItemStatus` is keyed on the GraphQL project-item id, not the issue number. Both fields are already on the production `ProjectItem` shape (`id` and `issueNumber`), so the production wiring is still a one-liner: each item from `listItemsInBoardOrder` maps directly. Do NOT widen `DoneCleanupItem` to add `itemId` — separate ports, separate shapes, narrow per consumer (CLAUDE.md § "narrow types").

### Strip-then-status ordering

The runner strips labels before setting status. Reasoning:

- Both AC and the load-bearing idempotency check require comparing `item.status` against the *target* column. The status read happens once at the top of the iteration (via `listItems`); the in-loop check uses that snapshot. Strip-then-status keeps the order matching how a future reader thinks: "first clear stale state, then move the card". Reversing it would work — neither order causes a visible bug because the in-loop status decision keys on the snapshot, not on a re-read.
- If `setItemStatus` happens to fail mid-iteration (e.g. transport error), the labels have already been stripped — the ticket is "halfway routed". Next cycle, `decideReworkRouting` still resolves the same `target` (the `needs-rework:*` label survives), `stripLabels` is now empty (already stripped), and the target-column check fires `setItemStatus` again. Resumable. Reversing the order would leave stale `ready:*` / `wip:*` on a card already in the target column — same recoverability, no advantage.

Either order is correct; the chosen order is "clear, then move", matching how `decideReworkRouting` itself reads (target first, stripLabels second is the type shape, but the strip is the auxiliary action — moving is the routing).

### Idempotency: explicit walk-through per AC

The AC pins two cases. Walk-through against the code:

| State | Path through the loop body |
| --- | --- |
| **No `needs-rework:*` label** | `decideReworkRouting` returns `{ target: null, stripLabels: [] }`. The `if (target === null) continue` short-circuits the entire iteration. **Zero `removeLabel`, zero `setItemStatus`, zero status read** (status was read via `listItems` regardless, but that's batch-level, not per-issue I/O). |
| **`needs-rework:po` present, already in `Backlog`, no stale `ready:* / wip:* / error:*`** | `target = "po"`, `stripLabels = []`. The strip `for` loop is empty (zero `removeLabel`). `targetColumn = "Backlog"`. `item.status === "Backlog"` → the `if` predicate is false → `setItemStatus` not called. **Zero mutations.** |
| **`needs-rework:po` + `ready:architect` + `wip:architect`, currently `In Architecture`** | `target = "po"`, `stripLabels = ["ready:architect", "wip:architect"]`. Strip loop fires `removeLabel(n, "ready:architect")` then `removeLabel(n, "wip:architect")`. `targetColumn = "Backlog"`. `item.status === "In Architecture"` → call `setItemStatus(itemId, "Backlog")`. **Two label removes, one status set, `needs-rework:po` retained.** |

The third row IS the happy path from the test plan.

### What `runReworkRouting` does NOT do

- **Does not remove the triggering `needs-rework:*` label.** `decideReworkRouting` already excludes it from `stripLabels` (routing.ts:44-46). The runner just passes that array through verbatim. Adding a defensive `.filter(l => l !== \`needs-rework:${target}\`)` here would (a) duplicate the pure function's contract and (b) silently mask a future bug if `decideReworkRouting`'s exclusion ever regressed.
- **Does not auto-advance forward (`Backlog → In Architecture`, etc.).** That's `runAutoAdvance` (separate runner). This routine only handles backward routing.
- **Does not consult the TRANSITIONS table directly.** All it knows about transitions is mediated through `decideReworkRouting` + `targetColumnForAgent`, both pure. If `Label` or `Column` widens, those decisions update; this file does not change.
- **Does not retry on transport errors.** `removeLabel` / `setItemStatus` propagate verbatim. Loop-level retry / circuit breaker is the dispatcher entrypoint's concern, mirroring `runDoneCleanup`'s posture.
- **Does not wire production deps.** Out of scope per the ticket body; happens with the dispatcher entrypoint ticket.

## Concurrency model

None. Sequential `for...of` over items; sequential `await` per `removeLabel`; one `await setItemStatus` per routed item. The dispatcher loop invokes `runReworkRouting` once per cycle, serialised against the other maintenance routines.

Bursting strips in parallel via `Promise.all` would amplify the GET-then-PUT round-trip on `removeLabel` and is rejected for the same rate-limit reason as `runDoneCleanup`. The rework-routing input set is small per cycle (only items carrying a `needs-rework:*` label, typically 0–2 per board); parallelism would not pay back its complexity.

## Error handling

No try/catch in this runner. `listItems`, `removeLabel`, and `setItemStatus` propagate transport errors verbatim. The loop runner (consumer ticket) decides abort / continue / circuit-break.

The one structural pre-condition: `targetColumnForAgent` is total over `Agent`, and `decideReworkRouting` only returns `target: Agent | null`. The non-null path is therefore safe to pass directly into `targetColumnForAgent` without runtime guard. `decideReworkRouting`'s `as Agent` cast in routing.ts:36 is bounded by the `needs-rework:` prefix match in the line above; a malformed `needs-rework:bogus` label would slip through as `target: "bogus"` and `AGENT_TO_COLUMN["bogus"]` would yield `undefined`. The runner does NOT defend against this — it's a `decideReworkRouting` contract issue, not this file's concern, and adding a guard here would be exactly the kind of defense-against-unobserved-failure CLAUDE.md flags. If it ever happens, `setItemStatus(itemId, undefined)` will throw downstream and surface the bad data; that's the right failure mode.

## Test plan (RED first)

### `test/pipeline/routing.test.ts` — extend with `describe("targetColumnForAgent", …)`

Add one block at the bottom of the existing file. Cases:

| Case | Expected |
| --- | --- |
| `targetColumnForAgent("po")` | `"Backlog"` |
| `targetColumnForAgent("architect")` | `"In Architecture"` |
| `targetColumnForAgent("developer")` | `"In Development"` |
| `targetColumnForAgent("code-review")` | `"In Code Review"` |
| structural invariant — iterate `REWORK_LABELS`, derive `Agent` via `label.slice("needs-rework:".length)`, assert `targetColumnForAgent(agent)` returns a value in `COLUMNS` and is non-empty | uses `COLUMNS` from `src/pipeline/transitions.ts`; pins exhaustiveness via runtime walk |

Use `it.each` for the four-row table; mirror the style of the existing "routes %s to its agent" block.

### `test/loop/runReworkRouting.test.ts` — new file

Mirror `test/loop/runDoneCleanup.test.ts`'s `makeRecorder` idiom. Extend the recorder shape with a `statusChanges: Array<{ itemId: string; statusName: string }>` list driven by the `setItemStatus` fake. Cases (the three AC cases plus a small set of structural guards):

| Case (`describe` / `it`) | Setup | Expected |
| --- | --- | --- |
| **happy path — strips stale labels and moves to target column** | One item: `{ itemId: "I_1", issueNumber: 42, status: "In Architecture", labels: ["needs-rework:po", "ready:architect", "wip:architect", "size:s"] }` | `removals` = `[(42, "ready:architect"), (42, "wip:architect")]` (order from `decideReworkRouting`'s filter walk). `statusChanges` = `[{ itemId: "I_1", statusName: "Backlog" }]`. `"needs-rework:po"` and `"size:s"` NOT removed. |
| **idempotency — same ticket post-routing** | One item: `{ itemId: "I_1", issueNumber: 42, status: "Backlog", labels: ["needs-rework:po", "size:s"] }` | `removals` empty. `statusChanges` empty. `listCalls` = 1. |
| **no rework label — untouched** | One item: `{ itemId: "I_2", issueNumber: 7, status: "In Architecture", labels: ["ready:architect", "size:s"] }` | `removals` empty. `statusChanges` empty. |
| **rework label present, stale labels stripped, column already correct** | One item: `{ itemId: "I_3", issueNumber: 8, status: "Backlog", labels: ["needs-rework:po", "ready:architect"] }` | `removals` = `[(8, "ready:architect")]`. `statusChanges` empty (status already `Backlog`). |
| **multiple items routed in iteration order** | Two items: `[{ itemId: "I_a", issueNumber: 100, status: "In Code Review", labels: ["needs-rework:developer", "ready:code-review"] }, { itemId: "I_b", issueNumber: 101, status: "In Documentation", labels: ["needs-rework:architect"] }]` | `removals` = `[(100, "ready:code-review")]`. `statusChanges` = `[{ itemId: "I_a", statusName: "In Development" }, { itemId: "I_b", statusName: "In Architecture" }]` (in iteration order). |

### What NOT to test

- Don't re-test `decideReworkRouting`'s `stripLabels` filter — `routing.test.ts` covers the strip contract (the existing "does NOT include the needs-rework:<target> label itself" test is the pin).
- Don't re-test `removeLabel`'s GET-then-PUT-only-if-present idempotency — `labels.test.ts` already covers it. This runner's idempotency comes from the AC-mandated "skip when nothing to do" gate, which the fakes verify by call count.
- Don't test transport-error propagation — same posture as `runDoneCleanup`. The absence of try/catch is visible at review.
- Don't add a `needs-rework:documentation` case — `documentation` is not in `Agent`. The structural invariant in `routing.test.ts` (iterating `REWORK_LABELS`) is the type-level guarantee; runtime branching here would just confirm a fact the type system already enforces.
- Don't test the `for...of` over an empty `items` array. Covered structurally by the loop body.

## Open questions

None. The ticket body fixes the function name, the DI shape, the strip mechanism (via `decideReworkRouting`), the new mapping export, and three AC test cases. This spec adds two structural test cases beyond the AC (multiple-item ordering, status-only-no-strip) and pins the strip-then-status ordering with explicit reasoning; no other discretion remains.

## Out of scope (do not implement here)

- Production wiring of `ReworkRoutingDeps` against `GitHubProjectClient` / `GitHubLabelsClient`. Happens with the dispatcher entrypoint ticket.
- Wiring `runReworkRouting` into the dispatcher loop. Same ticket as above.
- Promotion of test fakes to `test/loop/_helpers/`. Wait for a second consumer.
- Adding `runReworkRouting` to any barrel. CLAUDE.md forbids internal barrels.
- Changing `decideReworkRouting`'s contract (e.g. to surface the `Column` directly). The two-step decision (agent → column via a separate pure function) is the intended shape per the ticket body's AC #1.
- Forward auto-advance / closed-sweep / auto-merge runners. Separate tickets.
- Documenting the four-runner per-cycle architecture in `docs/knowledge/architecture/`. Documentation phase owns that file; architect does not write it.

## Definition of done

- `src/pipeline/routing.ts` exports `targetColumnForAgent`. ≤ ~10 lines added. No changes to `decideReworkRouting` or `Agent`.
- `src/loop/runReworkRouting.ts` exists, exports `runReworkRouting`, `ReworkRoutingDeps`, `ReworkRoutingItem`. ≤ 90 lines of production code (target ~50–60).
- `test/pipeline/routing.test.ts` extended with the `targetColumnForAgent` block (all four `Agent` values plus the structural invariant).
- `test/loop/runReworkRouting.test.ts` exists with the five cases above. All green.
- `pnpm typecheck && pnpm test` clean.
- No try/catch in `runReworkRouting.ts` (`rg -n 'try \{|catch' src/loop/runReworkRouting.ts` must return zero hits).
- `runReworkRouting.ts` does not import from any `src/github/` module (`rg -n "from \"\\.\\./github" src/loop/runReworkRouting.ts` must return zero hits).
- `runReworkRouting.ts` does not import from any other `src/pipeline/` module except `routing.ts` (the only pipeline decision it consumes).
- No edits to `src/pipeline/transitions.ts`, `src/pipeline/decisions.ts`, `src/github/labels.ts`, `src/github/project-client.ts`. Read-only consumers.
- Spec file committed alongside the implementation.
