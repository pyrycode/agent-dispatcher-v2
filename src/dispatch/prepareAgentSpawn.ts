// Pre-spawn phase 2: assemble the { args, env, cwd } descriptor that
// spawnClaude will consume. Does NOT invoke spawnClaude — the actual
// subprocess invocation stays in src/claude/spawn.ts. Separating the
// descriptor from the spawn lets unit tests pin argv shape and env-
// denylist propagation without process plumbing.
//
// This module's body MUST NOT import from src/claude/. The env-scrub
// surface is taken from injected deps so the launcher binds scrubSpawnEnv
// (src/claude/spawn.ts:51) at startup and unit tests DI fakes. The
// launcher binding reuses the real scrubSpawnEnv rather than re-deriving
// the denylist.
//
// spawnClaude itself prepends `-p --output-format stream-json`, so the
// descriptor's args are the caller-supplied tail only (see
// src/claude/spawn.ts:60-72).
//
// state.parentProjectItemId, when set, is appended to the descriptor's
// env as PYRY_PARENT_ITEM_ID AFTER scrubEnv runs — see #68 spec for the
// merge-order rationale (dispatcher-internal state must land in the child
// regardless of parentEnv contents).

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
  const scrubbed = deps.scrubEnv(deps.parentEnv);
  const env: NodeJS.ProcessEnv =
    state.parentProjectItemId === undefined
      ? scrubbed
      : { ...scrubbed, PYRY_PARENT_ITEM_ID: state.parentProjectItemId };
  return {
    args: state.args,
    env,
    cwd: state.worktreePath,
  };
}
