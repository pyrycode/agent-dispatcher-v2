// I/O wrapper around `claude -p --output-format stream-json`. Spawns the
// CLI, buffers stdout, and hands the buffer to the pure parser in stream.ts.
//
// Two contracts live here:
//   1. Argv shape: callers pass *what they want claude to do*; this wrapper
//      owns the streaming-output flags (-p --output-format stream-json).
//   2. Env scrub: dispatcher-internal variables (GitHub token, project board
//      IDs, Discord webhook, WIP counter, target repo path) MUST NOT
//      propagate into the child process. Forgetting the scrub leaks the
//      dispatcher's identity into the agent. The denylist is exported and
//      pinned by an exact-contents test against silent drift.
//
// The subprocess is invoked via an injectable runner so the test suite runs
// without `claude` on PATH. The default runner is unexported; the loop
// ticket can either use it as-is or inject its own (timeout / stdin / log
// tap) without renegotiating this wrapper's contract.

import { spawn } from "node:child_process";
import { type ParseStreamOpts, type StreamParseResult, parseStream } from "./stream.ts";

// Environment variables that MUST NOT propagate from the dispatcher's env
// into a spawned `claude` process. Ported verbatim from v1's
// agent-runtime.ts. Denylist over allowlist: claude relies on a wide and
// shifting set of env vars (PATH, HOME, LANG, LC_*, TMPDIR, NODE_*,
// ANTHROPIC_*, ...) and an allowlist would silently break on every new
// dependency. A small denylist keeps the leak surface bounded without
// reducing flexibility. Extend only when a concrete consumer reveals a new
// leak — every addition lands in its own commit so the exact-contents pin
// test forces it through review.
export const SPAWN_ENV_DENYLIST: ReadonlySet<string> = new Set([
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "PROJECT_NUMBER",
  "DISCORD_WEBHOOK_URL",
  "PYRY_MAX_CONCURRENT",
  "TARGET_REPO_PATH",
]);

export type ClaudeRunner = (
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; exitCode: number }>;

export interface SpawnClaudeOpts {
  readonly runner?: ClaudeRunner;
  readonly lastN?: number;
}

export function scrubSpawnEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (SPAWN_ENV_DENYLIST.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export async function spawnClaude(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  opts?: SpawnClaudeOpts,
): Promise<StreamParseResult> {
  const scrubbed = scrubSpawnEnv(env);
  const fullArgs = ["-p", "--output-format", "stream-json", ...args];
  const runner = opts?.runner ?? defaultRunner;
  const { stdout } = await runner("claude", fullArgs, scrubbed);
  const parseOpts: ParseStreamOpts | undefined =
    opts?.lastN === undefined ? undefined : { lastN: opts.lastN };
  return parseStream(stdout, parseOpts);
}

function defaultRunner(
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, exitCode: code ?? 0 });
    });
  });
}
