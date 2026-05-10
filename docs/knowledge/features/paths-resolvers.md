# `src/paths/` — repo path resolvers

Pure-function resolvers that compute absolute filesystem paths for the agents repo root and target repo root. They take state in (env values, fallbacks) and return decisions out — no `process.env`, no `__dirname`, no I/O. Call sites read env, capture launcher dirs, then pass strings down.

## Modules

| File | Export | Purpose |
| --- | --- | --- |
| `src/paths/agents-root.ts` | `resolveAgentsRoot` | Resolves the agents repo root (where the dispatcher's per-consumer config lives). |
| `src/paths/target-root.ts` | `resolveTargetRoot` | Resolves the target repo root (the consumer repo `agents/` lives inside of). |

Each module imports `node:path` only. They do not import each other; composition happens at the call site.

## API

```ts
interface ResolveAgentsRootOpts {
  envValue: string | undefined;   // e.g. process.env.AGENTS_REPO_PATH
  fallback: string | undefined;   // caller-derived (e.g. launcher-dir walk)
}
function resolveAgentsRoot(opts: ResolveAgentsRootOpts): string;

interface ResolveTargetRootOpts {
  envValue: string | undefined;   // e.g. process.env.TARGET_REPO_PATH
  agentsRoot: string | undefined; // the resolved agents root, passed through
}
function resolveTargetRoot(opts: ResolveTargetRootOpts): string;
```

Resolution order, both:
1. Non-empty env value → `resolve(envValue)`.
2. Else non-empty secondary input → for agents-root, `resolve(fallback)`; for target-root, `resolve(agentsRoot, "..")`.
3. Else throw an `Error` whose message names the env var.

## Invariants (do not regress)

- **`agents/` lives INSIDE the target repo, not as a sibling.** Target = parent of agents. v1 bug fixed in commit `c72adb4`; reintroducing the sibling layout breaks every consumer. Lock-in test in `test/paths/target-root.test.ts` ("does NOT reintroduce the `pyrycode/pyrycode/` bug").
- **Empty-string env counts as unset.** A `.env` file with a stray `AGENTS_REPO_PATH=` line reads as `""`, not `undefined`. Both resolvers gate on `typeof v === "string" && v.length > 0` for env values, fallbacks, and `agentsRoot` alike.

## Composition (downstream call site)

The eventual `src/dispatch/` entry point reads env once and threads the resolved paths to every I/O module:

```
dispatch entry-point
  ├─ envAgents  = process.env.AGENTS_REPO_PATH   ← I/O
  ├─ envTarget  = process.env.TARGET_REPO_PATH   ← I/O
  ├─ agentsRoot = resolveAgentsRoot({ envValue: envAgents, fallback: undefined })
  ├─ targetRoot = resolveTargetRoot({ envValue: envTarget, agentsRoot })
  └─ pass agentsRoot + targetRoot into worktree/, github/, salvage/, ...
```

One-way dependency: `target-root` consumes the agents-root output. Never the reverse.

## Errors

- Both throw a vanilla `Error` naming the env var (`AGENTS_REPO_PATH` / `TARGET_REPO_PATH`). Misconfiguration only — runtime callers don't recover; the dispatcher exits at the entry point.

## Notes

- The agents-root fallback parameter accepts caller-supplied values but the production call site passes `undefined`. See [../decisions/0001-agents-root-fallback-shape.md](../decisions/0001-agents-root-fallback-shape.md) for why no launcher-relative default ships in the resolver itself.
- `resolveDefaultBranch` (v1's third path helper) is out of scope here — it ships with `src/config/`.
