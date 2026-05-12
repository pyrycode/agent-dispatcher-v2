# Spec — #82: `prepareAgentSpawn` (pre-spawn phase 2)

## Files to read first

- `src/dispatch/setupBranchAndWorktree.ts:1-44` — structural template for this ticket. Mirror exactly: file header comment, `<Name>Deps` interface declared here, `<Name>Result` interface declared here, `(state, deps)` signature, straight-line body, direct imports only. No class, no factory.
- `src/dispatch/state.ts:1-13` — shared `DispatchState` contract. This ticket extends it with `worktreePath` and `args` (see "Design" below); the existing `agent` / `issueNumber` fields stay untouched.
- `src/claude/spawn.ts:30-58` — `SPAWN_ENV_DENYLIST` (the seven dispatcher-internal keys) and `scrubSpawnEnv` (the scrubber). This module's *body* must NOT import either; the launcher will bind `scrubSpawnEnv` into the deps interface. Read the signature so the dep contract below mirrors it: `(env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv`.
- `src/claude/spawn.ts:60-72` — `spawnClaude` prepends `-p --output-format stream-json` itself. Therefore the descriptor's `args` are the *caller-supplied tail only* (no double-prepend).
- `src/pipeline/selection.ts:24` — canonical `Agent` union. Already reused by `DispatchState`; no change here, just confirms the import is in place.
- `test/dispatch/setupBranchAndWorktree.test.ts:5-37` — fake-deps idiom (record calls into a `calls` array, return a stub from the fake closure) and the `makeState` helper pattern. Mirror both in the new test file. **Note**: this file's `makeState` will need its overrides updated to satisfy the extended `DispatchState` shape (see "Required edits to existing files" below).
- `test/claude/spawn.test.ts:36-71` — the existing scrubber tests. The new test file does NOT re-pin denylist contents (that pin lives in `spawn.test.ts` and stays load-bearing there); the new test only pins that the *injected* scrubber is invoked on the parent env, and that specific denylisted keys are absent from the returned env.
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — the rule that justifies `src/dispatch/` placement.
- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — both new files target ~30 / ~90 lines.
- `CLAUDE.md` § "Don't import from a barrel file" — internal imports stay direct.

## Context

Sibling #81 landed `src/dispatch/setupBranchAndWorktree.ts` and the shared `DispatchState` type. This ticket lands the next pre-spawn phase: `prepareAgentSpawn`. It assembles the `{ args, env, cwd }` descriptor that `spawnClaude` will consume — but it does NOT call `spawnClaude` itself. Separating the descriptor from the spawn lets unit tests pin argv shape and env-denylist propagation without process plumbing (no `child_process`, no PATH dependence).

Per CLAUDE.md § "Pure functions in `src/pipeline/`, I/O at the edges" this phase lives OUTSIDE `src/pipeline/` (it orchestrates env access through a dep) and inside `src/dispatch/` alongside sibling phases. The function body imports nothing from `src/claude/`; the env-scrub surface is taken from injected deps so unit tests DI fakes — AC bullet 2 is structurally enforced by the import block.

The prompt-assembly phase that produces `args` is a separate (still-to-be-ticketed) sibling of #76. This phase does not invent agent-specific flags; it propagates `args` from `DispatchState` as the upstream prompt-assembly phase populates them. See "Open questions" for the rationale.

## Design

### New / modified files

```
src/dispatch/
  state.ts                       (MODIFIED — +2 fields, ~17 lines total)
  prepareAgentSpawn.ts           (NEW — ~30 lines)
test/dispatch/
  setupBranchAndWorktree.test.ts (MODIFIED — makeState helper, +2 fields)
  prepareAgentSpawn.test.ts      (NEW — ~90 lines)
docs/specs/architecture/
  82-dispatch-prepare-agent-spawn.md   (NEW — this file)
```

No other file is touched. No barrel, no index — internal imports stay direct per CLAUDE.md § "Don't import from a barrel file."

### `src/dispatch/state.ts` (extension)

Add two fields. The existing `agent` and `issueNumber` stay; field order keeps existing fields first, new fields appended:

```ts
import type { Agent } from "../pipeline/selection.ts";

export interface DispatchState {
  readonly agent: Agent;
  readonly issueNumber: number;
  // Resolved path to the per-dispatch worktree. Populated by the prior
  // pre-spawn phase (setupBranchAndWorktree) and consumed by
  // prepareAgentSpawn as the descriptor's `cwd`.
  readonly worktreePath: string;
  // Caller-supplied tail args for `claude` (post-prompt-assembly).
  // spawnClaude prepends `-p --output-format stream-json` itself, so this
  // array does NOT include those flags. Populated by a future
  // prompt-assembly phase; until that phase exists, an orchestrator must
  // supply an explicit value (typically the assembled prompt as a single
  // positional argument).
  readonly args: readonly string[];
}
```

Rationale for adding both at once: this phase reads both (`worktreePath` → `cwd`; `args` → `args`). Per the #81 pattern ("fields are added only when a phase actually reads them"), both are required by this phase, so both land in this ticket.

### `src/dispatch/prepareAgentSpawn.ts` (new)

```ts
// Pre-spawn phase 2: assemble the { args, env, cwd } descriptor that
// spawnClaude will consume. Does NOT invoke spawnClaude — the actual
// subprocess invocation stays in src/claude/spawn.ts. Separating the
// descriptor from the spawn lets unit tests pin argv shape and env-
// denylist propagation without process plumbing.
//
// AC bullet 2 — this module's body MUST NOT import from src/claude/.
// The env-scrub surface is taken from injected deps so the launcher
// binds scrubSpawnEnv (src/claude/spawn.ts:51) at startup and unit
// tests DI fakes. AC bullet 3 — the launcher binding reuses the real
// scrubSpawnEnv rather than re-deriving the denylist.
//
// AC bullet 1 — args / env / cwd are returned; spawn is NOT invoked.
// spawnClaude itself prepends `-p --output-format stream-json`, so the
// descriptor's args are the caller-supplied tail only (see
// src/claude/spawn.ts:60-72).

import type { DispatchState } from "./state.ts";

export interface PrepareAgentSpawnDeps {
  // Launcher-bound scrubber. Production wires this to scrubSpawnEnv from
  // src/claude/spawn.ts:51; tests pass a fake.
  readonly scrubEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  // Captured snapshot of the dispatcher process env. Passed as a dep
  // (not read inside via process.env) so this module is pure w.r.t. the
  // ambient process — the test suite controls the input verbatim.
  readonly parentEnv: NodeJS.ProcessEnv;
}

export interface AgentSpawnDescriptor {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export function prepareAgentSpawn(
  state: DispatchState,
  deps: PrepareAgentSpawnDeps,
): AgentSpawnDescriptor {
  return {
    args: state.args,
    env: deps.scrubEnv(deps.parentEnv),
    cwd: state.worktreePath,
  };
}
```

### Imports allowed / forbidden

This module's import block is the structural enforcement of AC bullet 2:

- **Allowed**: `./state.ts` (sibling type).
- **Forbidden**: anything under `src/claude/` — including `scrubSpawnEnv` and `SPAWN_ENV_DENYLIST`. The launcher (future orchestrator) imports `scrubSpawnEnv` and binds it into `deps.scrubEnv`. If a future refactor leaks `from "../claude/..."` into this file, the architectural contract is broken regardless of test green.

The function is synchronous (no `await`). The scrubber is synchronous; env is data; cwd is a string. No I/O happens in this body — all I/O is performed by the launcher *before* (snapshotting `process.env`, binding `scrubSpawnEnv`) and *after* (handing the descriptor to `spawnClaude`).

## Data flow

```
caller (future orchestrator, post-setupBranchAndWorktree)
  │
  │ DispatchState { agent, issueNumber, worktreePath, args }
  │ + deps { scrubEnv, parentEnv }
  ▼
prepareAgentSpawn(state, deps)
  │
  │ deps.scrubEnv(deps.parentEnv)
  ▼
  scrubbed env
  │
  ▼
AgentSpawnDescriptor { args: state.args, env, cwd: state.worktreePath }
  │
  │ (later, in a sibling phase) spawnClaude(descriptor.args, descriptor.env, …)
  │ — note spawnClaude prepends `-p --output-format stream-json` itself
  ▼
ClaudeRunner → child process
```

No concurrency, no `AbortSignal` in this phase (synchronous data transform). Cancellation across the multi-phase sequence is the orchestrator's concern, not this one's.

## Error handling

No error paths. The body has no `await`, no `try`/`catch`, no I/O. The injected `scrubEnv` is documented as total (the production `scrubSpawnEnv` never throws — see `src/claude/spawn.ts:51-58`); if a test fake chooses to throw, the throw propagates verbatim to the caller. That posture matches sibling #81's "errors propagate verbatim" rule.

## Testing strategy

Test file: `test/dispatch/prepareAgentSpawn.test.ts`. Mirror the fake-deps idiom from `test/dispatch/setupBranchAndWorktree.test.ts:5-37` — fakes that record calls into a `calls` array and return stubs from a closure.

Two import notes for this test file:

1. The test file **MAY** import `scrubSpawnEnv` and `SPAWN_ENV_DENYLIST` from `src/claude/spawn.ts` for AC bullet 3's "reuses the real scrubber" assertion. The "no `src/claude/` import" rule is a *module body* rule, not a test rule.
2. The test file **MUST NOT** import `spawnClaude` or anything that performs real I/O — the unit under test is pure data assembly.

```ts
import { describe, expect, it } from "vitest";
import { SPAWN_ENV_DENYLIST, scrubSpawnEnv } from "../../src/claude/spawn.ts";
import { prepareAgentSpawn } from "../../src/dispatch/prepareAgentSpawn.ts";
import type { DispatchState } from "../../src/dispatch/state.ts";

function fakeDeps(opts: {
  parentEnv: NodeJS.ProcessEnv;
  scrubEnvImpl?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}) {
  const calls = { scrubEnv: [] as NodeJS.ProcessEnv[] };
  const deps = {
    parentEnv: opts.parentEnv,
    scrubEnv: (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
      calls.scrubEnv.push(env);
      return (opts.scrubEnvImpl ?? scrubSpawnEnv)(env);
    },
  };
  return { calls, deps };
}

function makeState(overrides?: Partial<DispatchState>): DispatchState {
  return {
    agent: "developer",
    issueNumber: 42,
    worktreePath: "/tmp/wt-42",
    args: ["the prompt"],
    ...overrides,
  };
}
```

Required cases (AC bullet 5):

1. **argv shape: descriptor.args === state.args (identity, no prepended flags)** — pin that this phase does NOT add `-p`, `--output-format`, or `stream-json` (spawnClaude owns those). Assert `result.args` deep-equals the state's `args`. Use a multi-element `args` like `["--model", "opus", "the prompt"]` so the test catches any future reordering.
2. **cwd shape: descriptor.cwd === state.worktreePath** — pin the cwd source. Use a sentinel path string (`"/sentinel/wt"`) and assert verbatim equality.
3. **env-denylist propagation — denylisted keys absent** — build a parentEnv containing every key in `SPAWN_ENV_DENYLIST` (loop) plus a known good key (`PATH: "/usr/bin"`). Use the real `scrubSpawnEnv` as the scrubber. Assert for each denylisted key that `(key in result.env) === false`; assert `result.env.PATH === "/usr/bin"`.
4. **env-denylist propagation — specific keys absent** (AC bullet 5 wording: "specific denylisted keys are absent") — separate assertion (not inside the loop) calling out at least three by name: `expect("GITHUB_TOKEN" in result.env).toBe(false)`, `expect("PYRY_MAX_CONCURRENT" in result.env).toBe(false)`, `expect("DISCORD_WEBHOOK_URL" in result.env).toBe(false)`. This is a readability pin: a future refactor that silently drops one of these keys from the denylist would be caught here even if the loop case were rewritten.
5. **scrubber is invoked on the parent env** — assert `calls.scrubEnv.length === 1` and `calls.scrubEnv[0] === deps.parentEnv` (reference identity, not deep equal). Pins that the function doesn't reach for `process.env` or some other env source.
6. **non-denylisted keys preserved** — parentEnv has `PATH`, `HOME`, `FOO: "bar"`; assert all three pass through verbatim. Catches a refactor that accidentally narrows the scrubber's output to an allowlist.

Cases 3 + 4 + 6 together cover AC bullet 3's "every key in SPAWN_ENV_DENYLIST is excluded" without re-pinning the denylist contents (that pin stays at `test/claude/spawn.test.ts:30-34`).

### Required edits to existing files

**`test/dispatch/setupBranchAndWorktree.test.ts`** — the `makeState` helper at line 31-37 returns a `DispatchState` literal with only `agent` and `issueNumber`. After adding `worktreePath` and `args` to `DispatchState`, that literal no longer satisfies the type. Update:

```ts
function makeState(overrides?: Partial<DispatchState>): DispatchState {
  return {
    agent: "developer",
    issueNumber: 42,
    worktreePath: "/tmp/wt-42",
    args: [],
    ...overrides,
  };
}
```

The existing test cases do not read the new fields and continue to pass unchanged. This is a 2-line addition, not a refactor.

## Acceptance criteria mapping

| AC bullet | Where pinned |
| --- | --- |
| `prepareAgentSpawn(state, deps)` exported from `src/dispatch/`, returns `{ args, env, cwd }`, does NOT invoke `spawn` / `spawnClaude` | `src/dispatch/prepareAgentSpawn.ts` — return statement; absence of any `await` or call into `src/claude/` |
| Body imports nothing from `src/claude/` — env-scrub via injected deps | Module import block — only `./state.ts` allowed |
| Returned `env` excludes every key in `SPAWN_ENV_DENYLIST`; reuses `scrubSpawnEnv` rather than re-deriving the denylist | Launcher (future) binds `deps.scrubEnv = scrubSpawnEnv`; pinned by test cases 3 + 4 + 6 |
| Consumes `DispatchState` from `src/dispatch/state.ts` rather than redeclaring | Module imports `DispatchState` from `./state.ts`; no local interface |
| Unit tests cover argv shape and env-denylist propagation (specific keys absent) | `test/dispatch/prepareAgentSpawn.test.ts` cases 1 + 3 + 4 |

## Out of scope

- Production wiring of `prepareAgentSpawn` from any real orchestrator. The orchestrator that composes pre-spawn phases is a later ticket; this ticket lands only the unit.
- The prompt-assembly phase that populates `DispatchState.args`. That phase is a separate sibling of #76 and decides what flags (`--model`, `--max-turns`, `--permission-mode`, …) belong in `args`. This ticket does not pre-empt that decision — `prepareAgentSpawn` propagates `args` verbatim.
- Modifying `src/claude/spawn.ts`. The denylist, the scrubber, and `spawnClaude` itself stay byte-identical.
- Modifying `src/dispatch/setupBranchAndWorktree.ts`. Its result type (`{ branch, worktreePath, kind }`) already exposes the `worktreePath` the future orchestrator will thread into `DispatchState.worktreePath`; this ticket does not couple to it directly.
- Touching `src/dispatch-bin.ts`, `src/loop/`, or anywhere else outside the files listed above.

## Open questions

- **Should `args` live in `DispatchState` or be passed as a separate parameter?** Decision: `DispatchState`. The function signature is fixed by the ticket body as `prepareAgentSpawn(state, deps)`, so a third positional is off the table; deps is launcher-bound (once at startup) and `args` is per-dispatch, so deps is the wrong home. State is the only remaining home. The future prompt-assembly phase will populate the field at the right point in the per-dispatch sequence.
- **Should this phase add any flags itself (e.g., `--max-turns`, `--model`)?** Decision: no. Per-agent flags are a prompt-assembly concern, not a spawn-descriptor concern; folding them in here would couple this phase to the (still-undecided) prompt-assembly contract. If a later ticket discovers that a flag genuinely belongs in this phase (e.g., a `--cwd` mirror), the field is added then with the consumer in hand — not pre-emptively.
