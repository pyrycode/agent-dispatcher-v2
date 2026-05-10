# agent-dispatcher-v2

TypeScript source for the v2 agent dispatcher. Small-file architecture: each module owns one decision; orchestration is thin glue over pure functions.

**Status:** scaffolding only. Initial behaviour ships ticket-by-ticket via the v1 dispatcher driving [`pyrycode/agent-dispatcher-v2-agents`](https://github.com/pyrycode/agent-dispatcher-v2-agents).

## Why a rewrite

v1 (`pyrycode/agent-dispatcher`) converged toward a clean architecture incrementally — but `dispatch.ts` and `reconcile.ts` carry historical layering that's hard to read in one sitting. v2 codifies the lessons explicitly:

- **Centralized label-cleanup transition table** — one `decideLabelDelta(before, after)` instead of four sprinkled call sites
- **Throughput equation parameterized end-to-end** — every gate takes `maxConcurrent`; no hardcoded `WIP=1` waiting to drift
- **One concern per file** — most files <100 lines, hardcap 200
- **Ecosystem-neutral from line one** — no Go strings; consumer config via `.env`

See [v1 → v2 lessons synthesis](https://github.com/pyrycode/agent-dispatcher) for the rationale.

## Repo layout (target)

```
src/
  pipeline/    # decisions, transitions, routing, sizing, blockers, selection
  github/      # project client, issues, labels, PRs, blocked-by mutations
  claude/      # spawn, stream-json parser, JSONL replay, env scrubbing
  worktree/    # create, cleanup, codegraph symlink, branch setup
  salvage/     # gate, draft PR, last-messages extraction
  paths/       # agents-root, target-root resolvers
  config/      # .env loading
  loop/        # cycle, auto-advance, reconcile maintenance
  dispatch/    # phases, to-agent orchestrator
  index.ts     # barrel
  dispatch-bin.ts  # entry point
test/          # mirrors src/
```

## Local development

```bash
pnpm install
pnpm typecheck
pnpm test
```

Node 22+. pnpm preferred.

## License

Apache-2.0.
