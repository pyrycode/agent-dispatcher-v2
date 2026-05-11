# Spec: `src/claude/spawn.ts` — invoke Claude CLI with env scrub (#62)

## Files to read first

- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — this file is an I/O wrapper, so subprocess + env access belong here (not in `src/pipeline/`).
- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — sizing ceiling.
- `CLAUDE.md` § "Belt-and-suspenders" — env scrub is the deterministic backstop against accidentally inheriting dispatcher secrets in a child run.
- `CLAUDE.md` § "Test-first" — RED → GREEN; tests assert denylist contents and the scrub contract before implementation.
- `src/claude/stream.ts:16-86` — `parseStream` signature + `StreamParseResult`/`ExitReason` shape. This wrapper's return type IS `StreamParseResult`; do not redefine.
- `test/claude/stream.test.ts:1-43` — fixture-loading pattern (`readFileSync(join(__dirname, "..", "fixtures", "claude-stream", name), "utf8")`); the integration test in this ticket reuses the SAME fixture files. Do not introduce new fixtures.
- `test/scaffold.test.ts:1-7` — vitest import pattern (`import { describe, expect, it } from "vitest"`) and the `.ts` extension on relative imports.
- v1 source of truth for the denylist + scrub: `agent-dispatcher-v2-agents/dispatcher/src/agent-runtime.ts:361-400` — port the seven-entry denylist VERBATIM (`GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `PROJECT_NUMBER`, `DISCORD_WEBHOOK_URL`, `PYRY_MAX_CONCURRENT`, `TARGET_REPO_PATH`). The doc comments at L363-378 explain why denylist-over-allowlist; preserve the rationale (paraphrase is fine, attribution to v1 is fine).
- v1 spawn shape for reference only: `agent-dispatcher-v2-agents/dispatcher/src/dispatch.ts:230-300` — argv-based `spawn("claude", [...])`, `stdio: ["pipe","pipe","pipe"]`, no `shell: true`. This ticket lifts the spawn discipline but NOT the timeout / stdin-pipe / live logging behaviour (those are the future `src/loop/` ticket's job).
- `package.json:11-18` — CI gates (`pnpm typecheck && pnpm test && pnpm lint`).
- `tsconfig.json:1-23` — strict mode + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` are on; design respects them.

## Context

`src/claude/` is the dispatcher's I/O surface to Claude CLI. `stream.ts` (#9) is the pure parser over `claude -p --output-format stream-json` output. This ticket adds the I/O wrapper that:

1. Spawns `claude` with the supplied args, buffers stdout to a string, and hands that string to `parseStream`.
2. Filters the env passed to the child through a denylist of dispatcher-internal variables (`GITHUB_TOKEN` and friends) so the child agent cannot act with the dispatcher's identity or read coordination state.

There is no consumer today — `src/loop/` lands later. The wrapper's job here is to fix the spawn argv shape, env-scrub policy, and parsed-result contract once, so the consumer ticket plugs in without re-deciding any of it.

### Why an injectable runner

The test suite must run without `claude` installed (CI, contributor laptops). The wrapper delegates the actual subprocess to a `ClaudeRunner` function passed in via `opts.runner` (default: real `child_process.spawn`). Tests inject a mock runner that returns a captured stream-json buffer; assertions then check that `spawnClaude`'s return value equals `parseStream(buffer)` for that buffer. This also gives future tickets (loop, salvage) a clean seam for further fault-injection (timeouts, kill signals) without re-plumbing.

## Design

### File: `src/claude/spawn.ts`

Single new file. One exported function (`spawnClaude`), one exported `const` (`SPAWN_ENV_DENYLIST`), one exported helper (`scrubSpawnEnv`), one exported type (`ClaudeRunner`), one re-export-by-reference (`StreamParseResult` flows through unchanged from `./stream.ts`). Estimated ~70–90 production lines; well under the 200-line hardcap.

#### Public surface

```ts
import { spawn } from "node:child_process";
import { parseStream, type ParseStreamOpts, type StreamParseResult } from "./stream.ts";

// Environment variables that MUST NOT propagate from the dispatcher's
// environment into a spawned `claude` process. Ported verbatim from v1's
// agent-runtime.ts. Denylist over allowlist: claude relies on a wide and
// shifting set of env vars (PATH, HOME, LANG, LC_*, TMPDIR, NODE_*,
// ANTHROPIC_*, ...) and an allowlist would silently break on every new
// dependency. A small denylist keeps the leak surface bounded without
// reducing flexibility.
export const SPAWN_ENV_DENYLIST: ReadonlySet<string> = new Set([
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "PROJECT_NUMBER",
  "DISCORD_WEBHOOK_URL",
  "PYRY_MAX_CONCURRENT",
  "TARGET_REPO_PATH",
]);

// Injectable subprocess runner. The default implementation invokes
// `child_process.spawn` with `shell: false`; tests inject a mock that
// returns a captured stream-json buffer.
export type ClaudeRunner = (
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; exitCode: number }>;

export interface SpawnClaudeOpts {
  readonly runner?: ClaudeRunner;
  readonly lastN?: number;
}

export function scrubSpawnEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

export function spawnClaude(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  opts?: SpawnClaudeOpts,
): Promise<StreamParseResult>;
```

#### Behaviour

`spawnClaude(args, env, opts?)`:

1. Compute `scrubbed = scrubSpawnEnv(env)` — a fresh object excluding every key in `SPAWN_ENV_DENYLIST`. Does not mutate `env`.
2. Compute `fullArgs = ["-p", "--output-format", "stream-json", ...args]`. The two leading flags are part of this wrapper's contract: callers express *what they want claude to do*, not the streaming-output policy. Passing `-p`/`--output-format` in `args` would double the flag — disallowed by contract but not validated (caller error).
3. Pick `runner = opts?.runner ?? defaultRunner`.
4. Await `const { stdout } = await runner("claude", fullArgs, scrubbed);` The runner's promise is allowed to reject (e.g. ENOENT when claude isn't on PATH); the rejection propagates to the caller untouched. The `exitCode` field is read but not currently surfaced — `parseStream` already extracts an `ExitReason` from the result message, which is what consumers route on. (See Open Question 1.)
5. Return `parseStream(stdout, opts?.lastN === undefined ? undefined : { lastN: opts.lastN })`. If the stream is empty or contains only malformed lines, `parseStream` yields `exitReason: "error"`, `totalCostUsd: 0`, no session id — the documented "stream killed mid-write" contract from #9.

`scrubSpawnEnv(parentEnv)`:

```ts
export function scrubSpawnEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (SPAWN_ENV_DENYLIST.has(key)) continue;
    out[key] = value;
  }
  return out;
}
```

Exported so tests can pin behaviour without going through the full `spawnClaude` path, and so future call sites (e.g. a follow-up that spawns a different subprocess) can reuse the policy.

#### Default runner (unexported)

```ts
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
```

Why these choices, briefly:

- **`shell: false` + argv array** — forecloses shell-quoting injection if a future caller threads user input into `args` (review issue #8/#22 in v1's history). The wrapper's contract is "argv, no shell."
- **`stdio: ["ignore", ...]`** — the future loop ticket will pipe the prompt over stdin; right now there's no consumer with a prompt to send. Default to ignored stdin; the loop ticket widens this when it needs to. **Note for the loop ticket:** revisit this when wiring the prompt-file pipe (`spawn` returns `child.stdin` only when `stdio[0] === "pipe"`).
- **stderr → parent's stderr** — claude's stderr is debug/progress noise that's safe to surface unredacted (claude itself doesn't print env vars or tokens). Silencing it would hide CLI startup errors during development.
- **`child.on("error", reject)`** — ENOENT, EACCES, etc. reject the promise. The wrapper's caller decides retry/escalate.
- **`code ?? 0`** — null on signal-kill. Treating signal as "exit 0" is wrong in general but harmless here because the wrapper doesn't currently surface `exitCode` (see step 4 above); a signal-killed run produces a truncated stdout, which `parseStream` then routes to `error`. If `exitCode` ever surfaces, change to `code ?? -1` and add a fixture.

The default runner is intentionally NOT exported. Tests don't need it (they inject mocks). The loop ticket — when it lands — can either import the wrapper as-is (running through the default runner) or, if it wants timeout / stdin / log-tap, inject a richer runner that the loop module owns. Both paths are open.

### File: `test/claude/spawn.test.ts`

Mirrors source path. Vitest, RED-first.

The integration test reuses `test/fixtures/claude-stream/success.jsonl` (already on disk, captured for #9). Do not add new fixtures.

Test groups:

1. **`SPAWN_ENV_DENYLIST` exact-contents pin**
   - One assertion: `Array.from(SPAWN_ENV_DENYLIST).sort()` equals the literal seven-entry sorted array. This is the silent-drift backstop the AC explicitly demands — adding or removing an entry without intent fails this test.

2. **`scrubSpawnEnv` removes every denylist key**
   - Input: `{ GITHUB_TOKEN: "secret", PATH: "/usr/bin", HOME: "/h", PYRY_MAX_CONCURRENT: "2", FOO: "bar" }`.
   - Assert: result has `PATH`, `HOME`, `FOO` with original values; `GITHUB_TOKEN` and `PYRY_MAX_CONCURRENT` are absent (`expect("GITHUB_TOKEN" in result).toBe(false)` — strict absence, not `=== undefined`, because `exactOptionalPropertyTypes` is on).
   - Assert: input object is not mutated (`"GITHUB_TOKEN" in inputCopy` still true on the original).

3. **`scrubSpawnEnv` covers every entry in the denylist**
   - Iterate `SPAWN_ENV_DENYLIST`; build an input with every key set to a sentinel; assert every key is absent in the scrubbed output. This is what catches the "added a new denylist entry but forgot to fix the loop" failure mode if `scrubSpawnEnv` is ever rewritten.

4. **`spawnClaude` passes scrubbed env to the runner**
   - Inject a runner that captures its `env` argument and returns a trivial buffer (e.g. one valid `system` init line).
   - Input env: contains `GITHUB_TOKEN: "secret"` and `PATH: "/usr/bin"`.
   - Assert: captured runner-env has no `GITHUB_TOKEN`, has `PATH: "/usr/bin"`.

5. **`spawnClaude` prepends `-p --output-format stream-json` to args**
   - Inject a runner that captures `cmd` and `args`. Call `spawnClaude(["--model", "opus", "--max-turns", "10"], {})`.
   - Assert: `cmd === "claude"`, `args === ["-p", "--output-format", "stream-json", "--model", "opus", "--max-turns", "10"]`.

6. **`spawnClaude` returns `parseStream(stdout)` for the success fixture**
   - Load `test/fixtures/claude-stream/success.jsonl` (reuse #9's fixture).
   - Inject a runner that returns `{ stdout: <fixture>, exitCode: 0 }` regardless of input.
   - Call `spawnClaude([], {})` and `parseStream(<fixture>)` independently.
   - Assert the two results are deep-equal across every field (`totalCostUsd`, `sessionId`, `lastAssistantMessage`, `lastNAssistantMessages`, `exitReason`).
   - This is the contract test the AC asks for.

7. **`spawnClaude` respects `lastN`**
   - Same setup as (6) but pass `{ lastN: 1 }` and assert the result equals `parseStream(stdout, { lastN: 1 })`. Pins the opts-passthrough wiring.

8. **`spawnClaude` propagates runner rejection**
   - Inject a runner that returns `Promise.reject(new Error("ENOENT"))`.
   - Assert `await expect(spawnClaude([], {})).rejects.toThrow("ENOENT")`. Failure to spawn the CLI is the caller's problem to route, not the wrapper's to swallow.

One `describe` per group; one `it` per assertion row where practical. No shared module-level state (each test builds its own mock runner).

### Implementation order (RED → GREEN, per CLAUDE.md)

1. Write `test/claude/spawn.test.ts` with all assertions. Run `pnpm test` → fails (file does not exist). RED.
2. Write `src/claude/spawn.ts`. Run `pnpm test` → all eight groups pass. GREEN.
3. Run `pnpm typecheck && pnpm lint` → both pass.
4. Commit spec + source + tests together.

### Files touched

- `src/claude/spawn.ts` — new, ~70–90 lines.
- `test/claude/spawn.test.ts` — new, ~90–130 lines (one `it` per assertion row).

No edits to existing files. No `src/index.ts` re-export. No new fixture files (reuses `test/fixtures/claude-stream/success.jsonl`).

## Concurrency model

Single subprocess per `spawnClaude` call. No shared state, no lock ordering. The returned promise resolves exactly once — on `child.on("close")` for the default runner, or on the injected runner's resolution for tests. No `AbortSignal` plumbing in this ticket — the loop ticket adds it when it owns subprocess lifecycle.

## Error handling

- **Runner rejects (ENOENT, EACCES, ...):** the promise from `spawnClaude` rejects with the same error. Caller's problem.
- **Subprocess exits with non-zero code but emits stdout:** the wrapper still calls `parseStream`. If the stream has no `result` message, `parseStream` returns `exitReason: "error"`. If it has a `result` message with `subtype: "success"`, `parseStream` returns `success` — non-zero exit + success result is a CLI contract violation and the wrapper trusts the stream (claude's own self-report), not the exit code. This matches `parseStream`'s documented "result is the source of truth" stance from #9.
- **Subprocess emits empty stdout:** `parseStream("")` yields `exitReason: "error"`, `totalCostUsd: 0`. No throw.
- **Subprocess emits malformed lines:** `parseStream` skips them silently. Already pinned by #9's tests.

The wrapper itself does not introduce a new try/catch. Its error policy is "propagate runner rejection; trust parser otherwise."

## Testing strategy

The denylist exact-contents pin (group 1) is the load-bearing test — it's the deterministic backstop against silent drift in the one piece of state where a forgotten entry leaks a real secret. The env-scrub passthrough test (group 4) is the integration of that contract with the spawn path.

The fixture-equivalence test (group 6) pins the parsed-result contract: `spawnClaude` adds no transformation on top of `parseStream`. If future maintenance widens the wrapper's return shape (e.g. to expose `exitCode`), this test forces the change to be explicit.

CI gates: `pnpm typecheck && pnpm test && pnpm lint`.

## Open questions

1. **Surface `exitCode` in the return shape?** Not today. `parseStream`'s `ExitReason` is what consumers route on, and the result message is more informative than the exit code (e.g. it carries `terminal_reason: "max_turns"` even when the CLI exits 0). If a future consumer needs the raw exit (e.g. for the safer-salvage gate predicate), wrap then: `{ result: StreamParseResult; exitCode: number }`. Until then, the leaner shape wins.

2. **`cwd` in the runner contract.** Not in this ticket. v1's spawn passes `cwd: opts.cwd` (the worktree). The loop ticket will need it; it can either widen the `ClaudeRunner` contract to `(cmd, args, env, opts?: { cwd?: string }) => Promise<...>` or inject its own runner that closes over a worktree path. Architect of the loop ticket picks.

3. **stdin handling.** Currently `stdio: ["ignore", ...]`. The loop ticket pipes the prompt file over stdin (v1 pattern, `dispatch.ts:273-279`). When it lands, change `stdio[0]` to `"pipe"` and add a runner option for the stdin source. Out of scope here because there's no prompt to send.

## Out of scope (explicit non-goals)

- Timeout / SIGTERM lifecycle. v1's dispatch.ts wires a timeout that kills the child; v2's loop ticket owns that, not this wrapper. Adding it here would force a contract change when the loop ticket wires up — better to land minimal and widen once.
- Live logging of stream messages (the `logStreamMessage` switch in v1 `dispatch.ts:281-296`). The loop ticket can subscribe by injecting a runner that tees stdout to a log file before resolving. This wrapper just buffers and returns parsed.
- Wiring `spawnClaude` into `src/loop/`. No `src/loop/` exists yet.
- Adding new env vars to `SPAWN_ENV_DENYLIST`. The ticket body explicitly defers extension to a follow-up "once concrete consumers reveal additional leaks." Resist the temptation to pre-populate.
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" bullet forbids barrel re-exports inside `src/`.
- Validating `args` for the leading `-p` / `--output-format` flags. Caller's responsibility; duplicated flags are caller error, not wrapper concern.

## Security review

**Verdict:** PASS

**Findings:**

- [Trust boundaries] No findings — design has a single explicit data boundary: subprocess stdout (untrusted shape) → `parseStream` → `StreamParseResult` (trusted struct). The wrapper introduces no new boundary; it threads bytes verbatim from the runner to the parser. Downstream code holds only `StreamParseResult`, which is frozen and shape-constrained.
- [Tokens, secrets, credentials] No findings — the core protection of this ticket. `SPAWN_ENV_DENYLIST` is exported, pinned by an exact-contents test, and applied unconditionally inside `spawnClaude` before the env reaches the runner. The seven entries are ported verbatim from v1's audited list and cover the dispatcher's secret + coordination surface (`GITHUB_TOKEN`, project board IDs, Discord webhook, WIP counter, target repo path). Denylist over allowlist is documented inline so a future maintainer doesn't "tighten" to an allowlist and silently break `PATH` / `HOME` / `ANTHROPIC_*` propagation. The wrapper does NOT log env contents anywhere — `defaultRunner` only pipes stderr through, and stderr is claude's own output, not the env it received.
- [File operations] N/A — design touches no filesystem paths.
- [Subprocess / external command execution] No findings — `defaultRunner` uses argv-based `spawn("claude", [...])` with `shell: false`, foreclosing shell-quoting injection if a future caller threads user input through `args`. Env is the scrubbed object, not `process.env` directly. The `cmd` is the literal string `"claude"` resolved through `PATH` (host-trust assumption; PATH-poisoning is a host-compromise problem outside this ticket's scope, per v1's audited rationale). The runner registers `child.on("error", reject)` so spawn failures (`ENOENT`, `EACCES`) propagate as promise rejections rather than silently producing an empty `StreamParseResult` that downstream might mistake for a legitimate `exitReason: "error"`.
- [Cryptographic primitives] N/A — no crypto.
- [Network & I/O] N/A — no sockets, no HTTP. The subprocess pipe is the only I/O channel and is parent-private (no listening port).
- [Error messages, logs, telemetry] No findings — `defaultRunner` writes claude's stderr through to the parent's stderr unredacted (claude does not emit env contents in stderr; this is the v1-audited behaviour). The wrapper itself logs nothing. Runner-rejection errors propagate with their original message (e.g. `"spawn claude ENOENT"`), which contains a binary name but no secret.
- [Concurrency] No findings — one subprocess per call, no shared mutable state, the promise resolves exactly once. `AbortSignal` / timeout is OUT OF SCOPE (deferred to the loop ticket); this is documented under Open Questions and the runner contract is intentionally narrow so the loop ticket can inject a richer runner without renegotiating the wrapper.
- [Threat model alignment] No findings — the dispatcher's threat surface here is "agent runs with dispatcher's GitHub identity and reads dispatcher coordination state." The denylist + scrub directly addresses that surface. The deferred extension policy (ticket body: "a follow-up may extend it once concrete consumers reveal additional leaks") is the right shape: every new dispatcher secret must explicitly land in the denylist in its own commit, where the exact-contents pin test forces the addition to be reviewed.

**Reviewer:** architect (self-review per `architect/security-review.md`)
**Date:** 2026-05-11
