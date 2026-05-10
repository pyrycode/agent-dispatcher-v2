# agent-dispatcher-v2 — Working Notes

This is the v2 dispatcher source repo. Agents are dispatched against this repo by the v1 dispatcher running from [`pyrycode/agent-dispatcher-v2-agents`](https://github.com/pyrycode/agent-dispatcher-v2-agents).

## Architectural rules

These are not soft preferences. They're the reason the rewrite exists.

### One concern per file, hardcap 200 lines

If a file approaches 200 lines, split it before adding more. Most files should land at 50–100 lines. Boundary is "one decision, one I/O surface, one data shape" — not "one class."

### Pure functions in `src/pipeline/`, I/O at the edges

Anything in `src/pipeline/` is a pure function. No `await`, no `gh` calls, no `git` calls, no filesystem reads. They take state in, return decisions out. Tests are trivial.

I/O lives in `src/github/`, `src/claude/`, `src/worktree/`, `src/salvage/` — and is called from `src/loop/` or `src/dispatch/`.

### The throughput equation is `min(...)` of every gate

Every gate that participates in throughput takes `maxConcurrent` as a parameter. No hardcoded `WIP=1`. No constants. The equation is:

```
actual_wip = min(
  selectDispatches.cap,
  decideAutoAdvance.backlog_cap,
  blocker_chain,
  MANUAL_ADVANCE_GATES,
)
```

Adding a new gate means adding a term. Read every term when bumping any one of them.

### `decideLabelDelta` is the only place labels mutate

Pre-dispatch / post-run / rework-routing / done-cleanup all funnel through one function: `decideLabelDelta(before, after) → { add, remove }`. The function reads the transition table in `src/pipeline/transitions.ts`.

If you need to add a new label-mutation site, you're doing something wrong — the existing four cover the universe of state transitions.

### Test-first

RED → GREEN → REFACTOR. Failing test in `test/` first, implementation after. Backfilling tests after the fact ships bugs first. Smell phrases that signal you're about to skip tests: *"straightforward state mutation,"* *"covered by integration check,"* *"trivial change,"* *"the existing tests still pass."*

## Belt-and-suspenders

Every "agent does X" rule needs a deterministic dispatcher-side safety net for X. Two stochastic rules verifying each other share the same failure mode. Examples ported from v1:

- **Empty-branch guard** (`shouldFlagEmptyBranch`) backstops the agent's "remember to commit" prose with a deterministic commit-count check
- **Auto-commit safety net** backstops the architect's "commit your spec" instruction
- **`hasOpenBlockers`** backstops architect's "check for blockers" prose with a deterministic GitHub query

When adding a new agent rule, ask: *"what deterministic check enforces this if the agent forgets?"* If there isn't one, the rule is advisory only — fine for low-cost cases, expensive for ones that ship broken work downstream.

## Sizing

XS / S only. No M. No "Why M, not split" paragraph. The discretionary escape is gone.

- **XS** — <30 lines production code; trivial change
- **S** — <100 lines; default for non-trivial tickets
- **>S → split** (architect's call, not PO's)

## Don't

- Don't import from a barrel file (`src/index.ts`) inside `src/` — barrels are for external consumers. Internal imports are direct: `from "./pipeline/transitions.ts"`.
- Don't add a "while I'm here" refactor in the middle of a ticket. File a follow-up; ship the ticket.
- Don't write a defense for a failure mode that hasn't been observed. Imagined failure modes are infinite; observed ones are bounded.
- Don't skip the predicate-audit pass when adding a new label or artifact variant. Every predicate that keys on the parent kind needs a re-read.

## Not yet implemented

The repo ships empty by design. Each ticket lands one module. The first ticket verifies the toolchain (`pnpm install && pnpm typecheck && pnpm test`). Subsequent tickets land `paths/`, `pipeline/transitions.ts`, `pipeline/decisions.ts`, etc. — see the agents repo's Inbox.
