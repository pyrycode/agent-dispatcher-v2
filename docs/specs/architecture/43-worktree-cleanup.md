# Architecture spec — #43 `src/worktree/cleanup.ts`

One idempotent worktree-removal primitive — `removeWorktree(path, spawn)` — that
the post-run cleanup phase and the create-time collision-retry path both call,
plus a pure parser `findCollidingWorktree(porcelain, target)` for unit testing
the locate step without touching the subprocess seam. This module makes no
decisions about which worktree to remove; it executes a removal robustly.

## Files to read first

The developer's turn-1 reading list. Each entry has a one-line "what to extract."

- `src/github/labels.ts:25-77` — **the shape to mirror.** Idempotency-by-precondition (read first, mutate only when needed) and the "no try/catch around transport — surface errors verbatim" posture. Note `removeLabel`'s GET-then-PUT-only-if-present is the exact analogue of our fs-exists-then-spawn-only-if-present gate.
- `src/github/labels.ts:1-17` — header-comment style. Mirror tone/length: state what the module does, what it decides NOT to do (which is "decide what to remove"), and the load-bearing idempotency invariant.
- `src/github/issues.ts:13-20` — `RestTransport` callable DI seam. **You will mirror this shape** for `Subprocess`: a single callable type, narrow input union, returns a `Promise<...>`. **Do not import or extend `RestTransport`** — it is HTTP-shaped (method/path/body); the subprocess seam has different inputs (argv) and different outputs (exitCode/stdout/stderr).
- `test/github/labels.test.ts:9-37` — `makeTransport(routes)` recording-mock pattern with a `calls` log. **Mirror this verbatim** as `makeSpawn(routes)` retyped to `Subprocess`. The `calls`-log is the verification mechanism for the "zero subprocess calls in the noop branch" assertion.
- `test/github/labels.test.ts:120-138` — the **already-absent-noop test pattern**. It pins `t.calls.length === 1` and the call's method, asserting the absence of mutating calls. Our test pins `t.calls.length === 0` for the path-doesn't-exist branch — same posture, stricter count.
- `docs/specs/architecture/36-github-labels.md` § "Why no `addLabel` skip-when-already-present optimization" — this module makes the **opposite** asymmetry call (read filesystem before spawning). The reason: the subprocess seam has real cost (process spawn) where a single REST POST does not, and the idempotency contract is loud (test pins zero calls). Different cost ratio → different default.
- `docs/PROJECT-MEMORY.md` § "Configuration loading (#3)" — "no `process.env` reads outside `src/config/env.ts`" applies. This module reads no env, takes its dependencies via parameter.
- `docs/PROJECT-MEMORY.md` § "src/pipeline/ purity (#6)" — **why `findCollidingWorktree` is pure-and-exported.** The parser takes `(porcelain, targetPath)` and returns a string-or-null; no `await`, no I/O. This mirrors the same testing posture as `parseCommitsAhead` in `blockers.ts` — pure parsers tested without seams.
- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — both `cleanup.ts` and `cleanup.test.ts` will land well under 100. Don't expand to fill.
- `CLAUDE.md` § "Belt-and-suspenders" — the dispatcher's "every agent that creates a worktree must clean up" prose is the agent rule; `removeWorktree`'s idempotency + auto-recovery is the deterministic safety net behind it (the empty-branch-guard / auto-commit family).

## Context

**Why now.** v1's lesson is that worktree leaks compound: a dispatch killed mid-run leaves a worktree under `feature/<n>`, and the next attempt to `git worktree add` fails because the branch is already checked out. v1 inlined `git worktree remove --force` at every cleanup site; the duplication meant the lock-aware retry path was implemented inconsistently (some callers retried, some didn't, none parsed `git worktree list --porcelain` to locate orphans by path). #43 lifts that into one helper.

**Why an idempotent contract.** Same shape rule as `removeLabel` (#36): the post-run cleanup phase runs unconditionally at the end of every dispatch. Forcing every caller into `try { removeWorktree(p) } catch (e) { if (!e.match(/not a working tree/)) throw }` is precisely the duplication that #36 eliminated for labels. The function absorbs the absent-state contract so the caller doesn't.

**Why an internal recovery loop instead of caller-driven retry.** The dispatcher has many failure-mode branches (max_turns, panic, OOM, killed); every cleanup site has the same lock/dirty-tree recovery. Inlining it once in `removeWorktree` means: post-run cleanup, salvage cleanup, create-time collision retry (a future ticket), and any ad-hoc `try-cleanup-then-retry` site all benefit. The recovery is bounded — one force, one retry — no unbounded loop.

**What this is not.** This module makes zero decisions. It does not own the dispatcher's "should I retry the create after cleanup?" semantic — that's the create-side helper's concern (separate ticket). It does not prune stale `git worktree list` entries whose directories were deleted out-of-band — that's `git worktree prune`'s job, out of scope. It is not a general-purpose subprocess wrapper.

## Design

### Module shape

```ts
// src/worktree/cleanup.ts

export interface SubprocessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// DI seam — callable that runs argv as a subprocess and resolves with
// exit/stdout/stderr. MUST NOT throw on non-zero exit; the function classifies
// exit codes, and a thrown rejection would bypass the recovery branches. The
// production wiring (a separate ticket) wraps `node:child_process.spawn`.
export type Subprocess = (
  argv: readonly string[],
) => Promise<SubprocessResult>;

// Idempotent. Throws only if the auto-recovery retry still fails (or the
// recovery's force-remove or list call fails). Path-doesn't-exist on disk is
// a noop with zero spawn calls; path-exists-but-not-registered is a noop
// after one (failed) `git worktree remove` and one `list --porcelain`.
export async function removeWorktree(
  path: string,
  spawn: Subprocess,
): Promise<void>;

// Pure helper. Parses `git worktree list --porcelain` output and returns
// the worktree path of the entry whose `worktree <path>` line equals
// `targetPath`, else `null`. Exported for unit testing without the seam.
export function findCollidingWorktree(
  porcelain: string,
  targetPath: string,
): string | null;
```

Three exports (`Subprocess`, `SubprocessResult`, `removeWorktree`,
`findCollidingWorktree`) — under the 5-export red line. No class, because
unlike `GitHubLabelsClient` there is no constructor-bound state to hold (no
`owner`/`repo` analogue). A free function with the seam as the second
parameter is the minimum-surface form.

### Subprocess seam — why a fresh type, not a reuse of `RestTransport`

`RestTransport` is HTTP-shaped: `(method, path, body) => unknown`. The
subprocess seam is shell-shaped: `(argv) => { exitCode, stdout, stderr }`.
Forcing one to model the other adds a translation layer at every
implementation site. Per the #6 narrow-types rule, each I/O boundary owns
its narrow type for its narrow concern — same justification that put three
flavours of `Agent` in three pipeline modules.

`Subprocess` MUST resolve (not reject) on non-zero exit. The function
classifies exit codes; a rejection would short-circuit the recovery. Tests
enforce this by their routing-table mock that always resolves. Production
wiring (separate ticket) builds a wrapper around `child_process.spawn` that
collects stdout/stderr and resolves on `'close'` regardless of exit code.

### Function flow

```ts
async function removeWorktree(path, spawn) {
  // 1. Filesystem fast path. Zero spawn calls when path is absent.
  if (!(await pathExists(path))) return;

  // 2. First attempt — bare remove.
  const r1 = await spawn(["git", "worktree", "remove", path]);
  if (r1.exitCode === 0) return;

  // 3. Recovery — locate, force, retry.
  const list = await spawn(["git", "worktree", "list", "--porcelain"]);
  if (list.exitCode !== 0) {
    throw new Error(`git worktree list failed: ${list.stderr.trim()}`);
  }
  const conflict = findCollidingWorktree(list.stdout, path);
  if (conflict === null) {
    // Path exists on disk but isn't a registered worktree — already
    // deregistered. Noop after the diagnostic list call.
    return;
  }

  const force = await spawn(["git", "worktree", "remove", "--force", conflict]);
  if (force.exitCode !== 0) {
    throw new Error(`git worktree remove --force failed: ${force.stderr.trim()}`);
  }

  // 4. If the force already removed our target, retry would be a noop —
  //    skip it. Otherwise retry the original removal once.
  if (conflict === path) return;

  const r2 = await spawn(["git", "worktree", "remove", path]);
  if (r2.exitCode !== 0) {
    // Surface the underlying error verbatim per AC. This is the
    // "retry-still-fails" branch.
    throw new Error(r2.stderr.trim() || `git worktree remove ${path} failed`);
  }
}
```

`pathExists` uses `node:fs/promises` `access` — a try/catch that returns
`false` on any error. It is private to the file (not a seam). Tests exercise
this branch by passing a path that genuinely doesn't exist on disk
(e.g. `path.join(os.tmpdir(), 'nonexistent-' + randomBytes(8).toString('hex'))`);
this is one syscall, no fixture setup. Other branches pass any path that
does exist (the test's own working directory, or a `mkdtempSync`'d dir);
the spawn mock controls everything beyond the existence check.

### Why fs-exists is the noop gate (and not "always list first")

The AC pins **zero** subprocess calls in the noop branch. Two candidate gates:

| Gate | Noop subprocess calls | Notes |
|---|---|---|
| `fs.access(path)` first | **0** | Satisfies AC. False-positive on stale-registered (path missing on disk but `git worktree list` still has it) is silent — that's `git worktree prune`'s concern, not ours. |
| `git worktree list --porcelain` first | 1 | Fails AC. |

Pyrycode's worktree dirs are uniformly under a known root (`agents-root`); a
deleted-out-of-band directory is rare and the prune-side concern. The fs
check is correct here.

### `findCollidingWorktree` — porcelain parser

`git worktree list --porcelain` output is a sequence of paragraphs separated
by blank lines:

```
worktree /Users/foo/repo
HEAD abc123...
branch refs/heads/main

worktree /Users/foo/.pyrycode-worktrees/architect-43
HEAD def456...
branch refs/heads/feature/43
```

The parser splits on `\r?\n\r?\n`, walks each block's lines, and returns the
first `worktree <p>` whose `<p>` exactly equals `targetPath`. Exact equality,
no `path.resolve` normalisation — the caller passes the same path it gave to
`git worktree add`, and `git worktree list` echoes that path verbatim. If
real-world drift surfaces (symlink resolution, trailing slash), normalise
**at the caller** per the #6 set-intersection-style-predicates rule
(`fileOverlapsAny` precedent). The parser stays a string-equality predicate.

The "or registered branch" half of the AC's locate phrase is a future
extension when the create-collision callsite supplies a branch (it knows
which branch it tried to add). For #43, by-path match is sufficient — the
post-run cleanup case calls `removeWorktree(path)` and the path itself is
the candidate. Adding a `branch?: string` parameter today speculates on the
future signature; widen at that callsite.

### Error handling — surface verbatim

Mirroring `labels.ts`'s "no catch around transport" posture:

| Failure | Behaviour |
|---|---|
| `r1` (bare remove) non-zero | enter recovery (do NOT throw yet) |
| `list --porcelain` non-zero | throw `git worktree list failed: <stderr>` |
| Force-remove non-zero | throw `git worktree remove --force failed: <stderr>` |
| `r2` (retry) non-zero | throw with `r2.stderr` verbatim — **the AC "retry-still-fails surfaces error verbatim" branch** |
| `pathExists` access error | treated as "doesn't exist" → noop. No filesystem permission errors are surfaced; if the worktree path is in a directory the dispatcher can't read, the cleanup couldn't have completed anyway. |
| `Subprocess` itself rejects | propagates verbatim; this is a contract violation (the seam shouldn't reject), surfacing it loudly is the right posture. No wrap-and-rethrow. |

`stderr` is `.trim()`-ed before interpolating into thrown error messages so
trailing newlines don't make the message ugly. The "verbatim" semantic in
the AC means the developer sees the original git error string — trimming
trailing whitespace doesn't violate that.

## Concurrency model

This module is single-call serial — no goroutines / workers / parallel
spawns. Each public call is a linear chain of awaited `spawn` invocations.
The dispatcher's loop layer is the concurrency owner; this module's calls
serialize within one dispatch's cleanup phase. Two simultaneous
`removeWorktree(samePath)` calls from independent dispatches would race,
but that's a higher-level invariant the loop layer enforces (one cleanup
per dispatch, dispatches don't overlap on the same path).

`fs.access` is sync-effect-shaped (one syscall, no IPC); spawn calls are
sequential. There is no `Promise.all` opportunity — every step depends on
the previous step's outcome.

## Testing strategy

File: `test/worktree/cleanup.test.ts`. Mirror the `makeTransport` shape from
`test/github/labels.test.ts:9-37` — a `makeSpawn(routes)` recording mock with
a `calls` log of `argv` arrays. Routes match by `argv` predicate, respond
with a `SubprocessResult`.

```ts
type Route = {
  match: (argv: readonly string[]) => boolean;
  respond: (argv: readonly string[]) => SubprocessResult | Promise<SubprocessResult>;
};
function makeSpawn(routes: readonly Route[]): {
  fn: Subprocess;
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn: Subprocess = async (argv) => {
    calls.push([...argv]);
    for (const r of routes) if (r.match(argv)) return r.respond(argv);
    throw new Error(`No route matched: ${argv.join(" ")}`);
  };
  return { fn, calls };
}
const ok = (stdout = ""): SubprocessResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): SubprocessResult => ({ exitCode: 1, stdout: "", stderr });
```

For "path exists" branches, generate a real temp dir with `fs.mkdtempSync` in
`beforeEach` and `rmSync(..., { recursive: true })` in `afterEach`. For "path
doesn't exist," use `path.join(os.tmpdir(), 'nonexistent-' + randomBytes(8).toString('hex'))`
without creating it.

The AC orders the integration tests; the developer should follow that order:

1. **Happy-path remove (path exists, single successful remove).** Real temp
   dir as `path`. One route: `argv === ["git","worktree","remove",path]` →
   `ok()`. Assert: `t.calls.length === 1`; `t.calls[0]` deep-equals
   `["git","worktree","remove",path]`.

2. **Already-absent noop — zero subprocess calls.** `path` is a never-created
   tmp path. **No routes registered** — any spawn call would hit
   `No route matched: ...` and fail the test. Assert: `t.calls.length === 0`
   (load-bearing pin). This is the AC's explicit "zero subprocess calls in
   the noop branch is asserted" requirement.

3. **Collision triggers locate→force-remove→retry path.** Real temp dir as
   `path`. Routes:
   - `["git","worktree","remove",path]` → `fail("fatal: ... locked working tree ...")`
   - `["git","worktree","list","--porcelain"]` → `ok(porcelainStub(path))`
     where `porcelainStub` returns a `worktree <path>\nHEAD ...\nbranch refs/heads/feature/43\n`
     paragraph.
   - `["git","worktree","remove","--force",path]` → `ok()`

   With `conflict === path`, the retry is skipped (per design). Assert:
   `t.calls.length === 3`; `t.calls[2]` deep-equals
   `["git","worktree","remove","--force",path]`. **Add a separate test** for
   the `conflict !== path` path (orphan at a different path, e.g. construct
   porcelain that registers a different absolute path matching by-path
   would be irrelevant since the parser matches `targetPath`; instead use
   the same path and verify `conflict === path` short-circuit). For #43,
   one collision test with `conflict === path` is enough; the retry-skip
   short-circuit is verified by `t.calls.length === 3` (not 4).

4. **Retry-still-fails surfaces the error verbatim.** This is the
   `conflict !== path` shape — orphan path P', force succeeds, retry fails.
   To exercise: hand-craft porcelain stub whose `worktree <P'>` line is a
   fixture path **different** from the target `path`; route the force on
   `P'` to `ok()`, and route the retry on `path` to `fail("CANARY: still locked")`.
   Assert: `removeWorktree(path, spawn)` rejects with an Error whose
   `.message` contains `"CANARY: still locked"`. Pattern is verbatim from
   `labels.test.ts` "transport-failure THROWS" (lines 73-95).

   **Note:** for this test the fixture orphan path needs to also exist on
   disk to satisfy `pathExists`; alternatively, construct the test so the
   target `path` exists on disk and the porcelain stub's `worktree` line
   matches a *different* path that the parser then locates. The simplest
   shape: keep `path` as the real temp dir, but the porcelain stub names a
   different fictitious path as its `worktree` entry — then
   `findCollidingWorktree` will return that fictitious path; the force
   route accepts it; the retry route on the real `path` fails. The
   subprocess seam's mock means none of these subprocess paths need to
   exist on disk.

**Pure-parser tests for `findCollidingWorktree`** — these don't need the
seam at all. Two `it` blocks suffice:

5. **Multi-block porcelain — finds entry by path.** Input is two blocks
   joined by `\n\n`; first block's `worktree` line is a different path,
   second block's `worktree` line equals `targetPath`. Assert returns
   `targetPath`.
6. **No match — returns null.** Input contains no block whose `worktree`
   line equals `targetPath`. Assert returns `null`.

Put pure-parser tests in their own `describe("findCollidingWorktree", ...)`
block; integration tests in `describe("removeWorktree", ...)`.

**No real `git` invocations.** Per AC. The hand-rolled routing-table mock is
the verification mechanism. Same posture as #19/#35/#36/#37.

**No `child_process` import in the test.** Per AC. Verified by inspection
(grep `child_process` in `test/worktree/cleanup.test.ts` should be empty).

## Open questions

- **Should `pathExists` itself be a seam?** No — fs reads are not what AC #3
  requires (AC names "subprocess invocation"). Adding a second seam doubles
  the API surface for marginal test ergonomics; real temp dirs in `beforeEach`
  are the established pattern. Resolved: real fs.

- **Should the `Subprocess` type live in a shared file (e.g. `src/runtime/`)
  for reuse by future subprocess callers?** Not yet. Per #6 narrow-types and
  CLAUDE.md "don't add abstractions beyond what the task requires", we keep
  it co-located. When a second `src/worktree/` module (e.g. `add.ts`) lands
  it can `import type { Subprocess } from "./cleanup.ts"` directly; promote
  to `src/runtime/subprocess.ts` only when a third caller exists or a
  cross-package import surface emerges. The labels-vs-issues `RestTransport`
  precedent (one shared, defined in the first lander) is the same shape — we
  follow it on the second lander, not pre-emptively.

- **What if `git worktree list --porcelain` returns a path that differs from
  the target by a trailing slash or a symlink?** Out of scope today. The
  parser is exact-equality. If observed, normalise at the caller (the
  dispatcher's worktree-path builder is the canonical source). Per CLAUDE.md
  "Don't write a defense for a failure mode that hasn't been observed."

- **Should the function attempt `git worktree prune` after a successful
  recovery to clean up other stale entries?** No — that's a scoping leak.
  `removeWorktree(path)` removes path; pruning is a separate primitive with
  a different contract.

## File hygiene

- Hardcap 200 lines (`cleanup.ts`). Expected actual: 60–80 production lines
  including the parser.
- Hardcap 200 lines (`cleanup.test.ts`). Expected actual: 130–170 lines
  including the `makeSpawn` helper and fixtures.
- No `process.env` reads.
- No imports from `src/index.ts`.
- No `child_process` import in `cleanup.ts` (the production wiring of the
  `Subprocess` seam lives in a future ticket — `cleanup.ts` only declares
  the type).
- No `child_process` import in `cleanup.test.ts` (per AC #3).
- Module exports: `removeWorktree`, `findCollidingWorktree`, `Subprocess`,
  `SubprocessResult`. `pathExists` is file-local.
- Header comment ~10 lines: states what the module does (idempotent
  primitive + auto-recovery), what it does NOT decide (which worktree to
  remove, when to retry creates), and the load-bearing idempotency
  invariant.

## Implementation checklist (developer-facing)

1. Create `src/worktree/cleanup.ts` exporting `Subprocess`, `SubprocessResult`,
   `removeWorktree(path, spawn)`, `findCollidingWorktree(porcelain, target)`
   per § Design.
2. Create `test/worktree/cleanup.test.ts` covering AC tests 1–4 in order
   (integration through the seam) plus tests 5–6 (pure-parser). Reuse the
   `makeSpawn` recording-mock pattern from `test/github/labels.test.ts:9-37`.
3. Confirm by grep that `cleanup.test.ts` does not import `child_process`.
4. Run `pnpm typecheck && pnpm test && pnpm lint`. All green is the bar.
