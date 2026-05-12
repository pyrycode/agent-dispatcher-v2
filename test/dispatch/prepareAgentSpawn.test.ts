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

describe("prepareAgentSpawn", () => {
  it("argv shape: descriptor.args === state.args (no prepended flags)", () => {
    const { deps } = fakeDeps({ parentEnv: { PATH: "/usr/bin" } });
    const state = makeState({ args: ["--model", "opus", "the prompt"] });

    const result = prepareAgentSpawn(state, deps);

    // spawnClaude owns `-p --output-format stream-json`; this phase does NOT
    // prepend them. Deep-equal pin catches any future reordering or sneaky
    // flag injection.
    expect(result.args).toEqual(["--model", "opus", "the prompt"]);
    expect(result.args).toBe(state.args);
  });

  it("cwd shape: descriptor.cwd === state.worktreePath", () => {
    const { deps } = fakeDeps({ parentEnv: { PATH: "/usr/bin" } });
    const state = makeState({ worktreePath: "/sentinel/wt" });

    const result = prepareAgentSpawn(state, deps);

    expect(result.cwd).toBe("/sentinel/wt");
  });

  it("env-denylist propagation: every key in SPAWN_ENV_DENYLIST is absent from result.env", () => {
    const parentEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    for (const key of SPAWN_ENV_DENYLIST) {
      parentEnv[key] = `sentinel-${key}`;
    }
    const { deps } = fakeDeps({ parentEnv });

    const result = prepareAgentSpawn(makeState(), deps);

    for (const key of SPAWN_ENV_DENYLIST) {
      expect(key in result.env).toBe(false);
    }
    expect(result.env.PATH).toBe("/usr/bin");
  });

  it("env-denylist propagation: specific denylisted keys absent (named)", () => {
    const parentEnv: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: "secret",
      PYRY_MAX_CONCURRENT: "2",
      DISCORD_WEBHOOK_URL: "https://example.invalid/hook",
      PATH: "/usr/bin",
    };
    const { deps } = fakeDeps({ parentEnv });

    const result = prepareAgentSpawn(makeState(), deps);

    expect("GITHUB_TOKEN" in result.env).toBe(false);
    expect("PYRY_MAX_CONCURRENT" in result.env).toBe(false);
    expect("DISCORD_WEBHOOK_URL" in result.env).toBe(false);
  });

  it("scrubber is invoked exactly once on deps.parentEnv (reference identity)", () => {
    const parentEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin", FOO: "bar" };
    const { calls, deps } = fakeDeps({ parentEnv });

    prepareAgentSpawn(makeState(), deps);

    expect(calls.scrubEnv.length).toBe(1);
    expect(calls.scrubEnv[0]).toBe(deps.parentEnv);
  });

  it("non-denylisted keys preserved verbatim", () => {
    const parentEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/h",
      FOO: "bar",
    };
    const { deps } = fakeDeps({ parentEnv });

    const result = prepareAgentSpawn(makeState(), deps);

    expect(result.env.PATH).toBe("/usr/bin");
    expect(result.env.HOME).toBe("/h");
    expect(result.env.FOO).toBe("bar");
  });
});
