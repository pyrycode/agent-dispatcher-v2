# Architecture spec — #44 `src/worktree/create.ts`

One thin worktree-creation primitive — `createWorktree(branch, repoRoot, worktreeDir, spawn)` —
plus a pure parser `findWorktreesForBranch(porcelain, branch)` for unit-testing the
porcelain walk without the seam. Mirrors the shape established by `cleanup.ts`
(#43): one I/O wrapper + one pure parser + a co-located `Subprocess` type, free
function (no class), errors surfaced verbatim. This module makes no decisions
about collision recovery — that's the dispatch-layer integration's concern.

## Files to read first

The developer's turn-1 reading list. Each entry has a one-line "what to extract."

- `src/worktree/cleanup.ts:23-33` — **`Subprocess` / `SubprocessResult` types to reuse.** Import them from `./cleanup.ts` directly; do NOT redefine. Per the #6 narrow-types ladder this is the "second importer" step — promotion to a shared module is the *third* caller's concern.
- `src/worktree/cleanup.ts:83-91` — **`findCollidingWorktree` is the precedent parser.** Block-split on `\r?\n\r?\n`, line-walk inside each block, pick out lines starting with `"worktree "` and `"branch "`. Mirror this exact shape; the new parser walks the same grammar but gathers `(path, branch)` pairs instead of locating-by-path. **Do NOT refactor cleanup.ts to share a tokenizer** — "while I'm here" refactor, forbidden by CLAUDE.md.
- `src/worktree/cleanup.ts:1-19` — header-comment style. Mirror tone/length: state what the module does, what it does NOT decide (collision recovery), and the load-bearing invariant (subprocess seam contract).
- `test/worktree/cleanup.test.ts:1-46` — **`makeSpawn` recording mock + `ok` / `fail` / `argvEq` helpers.** Mirror this verbatim in `test/worktree/create.test.ts`. The `calls` log is the verification mechanism for argv-shape assertions ("rev-parse pre-flight ran", "worktree add ran with `-b`", etc.).
- `test/worktree/cleanup.test.ts:133-155` — pure-parser test pattern. The `describe("findCollidingWorktree", ...)` block is the template for `describe("findWorktreesForBranch", ...)`. No seam at all in pure-parser tests.
- `docs/specs/architecture/43-worktree-cleanup.md` § "Subprocess seam — why a fresh type, not a reuse of `RestTransport`" — context for why argv-in / `{exitCode, stdout, stderr}`-out is the right shape, and why `Subprocess` MUST resolve (not reject) on non-zero exit. Same contract here.
- `docs/PROJECT-MEMORY.md` § "src/worktree/ cleanup primitive (#43)" — directory-level patterns: free function over class (no state to bind), exact-match-or-null parsers, errors `.trim()`-ed but verbatim, no `child_process` import in tests.
- `docs/PROJECT-MEMORY.md` § "src/pipeline/ purity (#6)" — narrow-types ladder. `WorktreeInfo` includes only `path` + `branch`; do NOT widen for hypothetical consumers.
- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — both `create.ts` and `create.test.ts` will land well under 100. Don't expand to fill.
- `CLAUDE.md` § "Test-first" — RED → GREEN → REFACTOR. Failing tests in `test/worktree/create.test.ts` first, then implementation.
- `CLAUDE.md` § "Don't … 'while I'm here' refactor" — tempting to unify cleanup's parser with this one. File a follow-up; ship the ticket.

## Context

**Why now.** `src/worktree/cleanup.ts` (#43) lands the removal half of the
dispatcher's worktree primitives. This ticket lands the creation half. Together
they form the minimal surface the dispatch layer composes per agent run:
remove-if-leftover (defensive) → create → run agent → remove (cleanup).

**Why split the parser.** `git worktree list --porcelain` output is a tiny
line-oriented format whose parsing is the part most likely to break across git
versions or on edge cases (detached HEADs, locked worktrees, `bare`-only
blocks). Keeping it pure means the boring tests live next to the predicate and
the I/O wrapper stays a thin shell — same posture as `findCollidingWorktree`.

**Why a fresh creation primitive instead of inlining at the dispatch layer.** v1
inlined `git worktree add` at every dispatch site; the duplication meant the
"branch already exists, reuse without `--detach`" semantic was implemented
inconsistently. #44 lifts that into one helper.

**What this is not.** This module makes zero collision-recovery decisions. If
`git worktree add` fails because the path is already registered or the branch
is checked out elsewhere, the error surfaces verbatim. The dispatch-layer
integration (separate, future ticket) is the place where `removeWorktree` is
composed in front of `createWorktree` for retry semantics. Per the #43 spec's
"What this is not" — cleanup makes no creation decisions; create makes no
removal decisions; the dispatch layer composes both.

## Design

### Module shape

```ts
// src/worktree/create.ts

import type { Subprocess } from "./cleanup.ts";

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string;
}

// Creates `worktreeDir` as a git worktree on `branch`, rooted at `repoRoot`.
// If `branch` does not exist, creates it from HEAD (`-b` form). If it exists,
// checks out the existing branch (no `--detach`, no re-create). Returns the
// absolute path of the worktree.
//
// Errors propagate verbatim from the underlying `git` subprocess. Collision
// recovery (path already registered, branch already checked out elsewhere) is
// the dispatch layer's concern — see § "Errors propagate verbatim" below.
export async function createWorktree(
  branch: string,
  repoRoot: string,
  worktreeDir: string,
  spawn: Subprocess,
): Promise<string>;

// Pure parser. Walks `git worktree list --porcelain` paragraphs and returns
// every entry whose `branch refs/heads/<name>` line equals `branch`. Blocks
// without a `branch` line (bare, detached) are silently skipped. Exported for
// unit-testing without the seam.
export function findWorktreesForBranch(
  porcelain: string,
  branch: string,
): WorktreeInfo[];
```

Three exports — `WorktreeInfo`, `createWorktree`, `findWorktreesForBranch` —
under the 5-export red line. No class (mirrors `cleanup.ts`: no state to bind).
`Subprocess` and `SubprocessResult` are imported from `./cleanup.ts`, not
redefined — same one-shared / second-imports / third-promotes ladder used for
`GraphQLTransport` (#37 imports from #19) and `RestTransport` (#36 imports from
#35).

### Function flow — `createWorktree`

```ts
async function createWorktree(branch, repoRoot, worktreeDir, spawn) {
  // 1. Pre-flight: does the branch already exist? `git rev-parse --verify
  //    --quiet refs/heads/<branch>` returns exit 0 if yes, 1 if no. Any other
  //    exit is abnormal — surface verbatim.
  const probe = await spawn([
    "git", "-C", repoRoot, "rev-parse", "--verify", "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (probe.exitCode !== 0 && probe.exitCode !== 1) {
    throw new Error(probe.stderr.trim() || `git rev-parse failed (exit ${probe.exitCode})`);
  }
  const branchExists = probe.exitCode === 0;

  // 2. Create the worktree. `-b` form when branch is new; bare form (with the
  //    branch ref as the second positional arg) when reusing.
  const argv = branchExists
    ? ["git", "-C", repoRoot, "worktree", "add", worktreeDir, branch]
    : ["git", "-C", repoRoot, "worktree", "add", "-b", branch, worktreeDir];
  const add = await spawn(argv);
  if (add.exitCode !== 0) {
    throw new Error(add.stderr.trim() || `git worktree add failed (exit ${add.exitCode})`);
  }

  // 3. AC: return the absolute path. `path.resolve(repoRoot, worktreeDir)`
  //    handles both absolute and relative `worktreeDir`; if absolute, resolve
  //    is a noop, otherwise it joins against repoRoot (the natural base for a
  //    git -C invocation).
  return resolve(repoRoot, worktreeDir);
}
```

Two spawn calls on the happy path. No filesystem reads (cleanup.ts's
`pathExists` fast-path is removal-specific — there's no analogue here, since
"the worktree to be created already exists on disk" is the collision case the
dispatch layer handles, not silently absorbed here).

### Why `git -C <repoRoot>` over a `cwd` seam parameter

The existing `Subprocess` type from `cleanup.ts` is `(argv) => Promise<...>` —
no `cwd`. Widening it to `(argv, opts?: { cwd? }) => Promise<...>` would cascade
into cleanup.ts's tests and any future caller, with no benefit `git -C` doesn't
already provide. `git -C <path> <subcommand>` is the documented idiom for "run
this git command rooted somewhere else." Per the #6 narrow-types rule, we keep
the seam minimal.

### Why pre-flight `rev-parse` over "try `-b`, fall back on failure"

Two candidate shapes for the branch-exists check:

| Shape | Spawn calls (happy path) | Notes |
|---|---|---|
| Pre-flight `rev-parse` | 2 (probe + add) | Deterministic argv; both branches surface errors verbatim. Test surface is one route per call. |
| `-b` first, fallback on stderr | 1 or 2 | Couples this module to git's exact error-message wording for "branch already exists." Brittle across git versions. |

Pre-flight wins on robustness. The extra round-trip is one process spawn — same
order of magnitude as the worktree-add itself.

### `findWorktreesForBranch` — porcelain parser

Same grammar as `findCollidingWorktree` (#43), different output shape:

```
worktree /Users/foo/repo
HEAD abc123...
branch refs/heads/main

worktree /Users/foo/.pyrycode-worktrees/architect-44
HEAD def456...
branch refs/heads/feature/44

worktree /Users/foo/.pyrycode-worktrees/detached
HEAD 999...
detached
```

The parser splits on `\r?\n\r?\n`, walks each block looking for `worktree <p>`
and `branch refs/heads/<name>` lines, and emits `{ path, branch: <name> }` for
every block whose branch equals the input. Blocks without a `branch` line (the
detached-HEAD block above, plus `bare` blocks) are silently skipped — AC's
"malformed lines silently skipped."

Branch matching is exact-equality on the suffix after `refs/heads/`. The caller
passes the short branch name (`feature/44`); the parser strips the
`refs/heads/` prefix porcelain prepends. **Caller does NOT pass `refs/heads/...`**
— same posture as `findCollidingWorktree` (caller passes the path it gave to
`git worktree add`, parser matches what porcelain echoes).

Multiple matches are possible (a branch can technically be checked out at
multiple paths via `git worktree add --force`), so the return is an array. AC
unit tests pin both single-match and multiple-match cases.

Lines that aren't recognizable as `worktree ` / `branch ` / blank don't break
the walk — they're ignored. Same posture as `findCollidingWorktree`.

### Errors propagate verbatim

Mirroring `cleanup.ts`'s "no catch around transport" posture:

| Failure | Behaviour |
|---|---|
| `rev-parse` exit ∉ {0, 1} | throw `<stderr>` (or fallback `git rev-parse failed (exit N)`) |
| `worktree add` non-zero | throw `<stderr>` (or fallback `git worktree add failed (exit N)`) — covers "already checked out at X", "directory exists", and any other collision |
| `Subprocess` itself rejects | propagates verbatim (contract violation; `Subprocess` MUST resolve) |

`stderr` is `.trim()`-ed before throwing so trailing newlines don't make the
message ugly — same posture as cleanup.ts's `r2` retry-fail branch.

The AC's "subprocess error surfaces verbatim" branch is the integration test
(test #3 below) — assert that the canary stderr substring appears in the
caught Error's message.

### Return value: absolute path

`createWorktree` returns the absolute path of the created worktree. Use
`path.resolve(repoRoot, worktreeDir)`:

- If `worktreeDir` is already absolute, `resolve` returns it unchanged (modulo
  trailing-slash normalization).
- If relative, it joins against `repoRoot` — the same base `git -C` uses, so
  the returned path matches what `git worktree list --porcelain` will echo.

No `realpath` / symlink resolution. `git` doesn't resolve symlinks in
`worktree list` either; matching that posture keeps caller paths consistent
with what porcelain reports.

## Concurrency model

This module is single-call serial — no goroutines / workers / parallel spawns.
Each public call is two awaited `spawn` invocations in sequence. Same posture
as `cleanup.ts`. The dispatcher's loop layer is the concurrency owner; this
module does not coordinate with siblings.

## Testing strategy

File: `test/worktree/create.test.ts`. Reuse the `makeSpawn` / `ok` / `fail` /
`argvEq` helpers from `test/worktree/cleanup.test.ts:1-46` — copy them
verbatim (do NOT extract to a shared test util in this ticket; second user is
the typical promotion threshold, but the helpers are ~30 lines and copy-paste
is cheaper than the test-util-module refactor right now; file follow-up if a
third worktree test file lands).

```ts
import {
  type Subprocess,
  type SubprocessResult,
} from "../../src/worktree/cleanup.ts";
import {
  type WorktreeInfo,
  createWorktree,
  findWorktreesForBranch,
} from "../../src/worktree/create.ts";
```

No `mkdtempSync` / `rmSync` lifecycle is needed — `createWorktree` does NO
filesystem reads (unlike `removeWorktree`'s `pathExists` fast-path). Every
branch is exercised through the spawn mock alone.

### Integration tests for `createWorktree` (AC order)

1. **Happy-path new branch — pre-flight reports absent, `-b` form runs.**
   Routes:
   - `["git","-C",REPO,"rev-parse","--verify","--quiet","refs/heads/feature/44"]`
     → `fail("")` with `exitCode: 1` (branch absent).
   - `["git","-C",REPO,"worktree","add","-b","feature/44",WORKTREE]` → `ok()`.

   Assert: returned path is `path.resolve(REPO, WORKTREE)`; `t.calls.length === 2`;
   `t.calls[1]` deep-equals the `-b` argv. `REPO` and `WORKTREE` are arbitrary
   string fixtures (e.g. `"/tmp/repo"`, `"/tmp/wt-44"`); they don't need to
   exist on disk because the seam is mocked.

   Note: the `fail("")` helper resolves to `{exitCode:1, stdout:"", stderr:""}`
   — exit 1 is the documented absent-branch signal from `rev-parse --verify
   --quiet`. The test pins this contract; if the parser later treats exit 1 as
   error, this test fails first.

2. **Branch already exists — pre-flight reports present, bare form runs (no `-b`).**
   Routes:
   - `["git","-C",REPO,"rev-parse","--verify","--quiet","refs/heads/feature/44"]`
     → `ok()` (exit 0 — branch present).
   - `["git","-C",REPO,"worktree","add",WORKTREE,"feature/44"]` → `ok()`.

   Assert: returned path is `path.resolve(REPO, WORKTREE)`; `t.calls.length === 2`;
   `t.calls[1]` deep-equals the bare argv (`worktree add <path> <branch>`,
   not `-b`). The bare-vs-`-b` discrimination is the load-bearing pin — a
   future "always use `-B`" simplification breaks this assertion.

3. **Subprocess error surfaces verbatim — `worktree add` fails on collision.**
   Routes:
   - `rev-parse` → `ok()` (branch exists).
   - `worktree add` (bare form) → `fail("fatal: '/tmp/wt-44' already exists")`
     — the canary substring.

   Assert: `createWorktree(...)` rejects with an Error whose `.message`
   contains `"already exists"`. Same pattern as `cleanup.test.ts`'s "list fails
   — surfaces stderr verbatim." Pinning the substring (not the full message)
   tolerates the `.trim()` step without coupling to it.

   This test also covers AC's "branch already checked out elsewhere" failure
   shape: same code path (worktree add non-zero exit → throw stderr verbatim),
   different stderr fixture would land in the same assertion.

### Pure-parser tests for `findWorktreesForBranch`

These don't need the seam at all. Four `it` blocks per AC ("single match,
multiple matches, no matches, malformed lines silently skipped"):

4. **Single match — returns one entry.** Two-block porcelain; second block's
   `branch refs/heads/feature/44` matches. Assert returns
   `[{ path: "/Users/foo/.pyrycode-worktrees/architect-44", branch: "feature/44" }]`.

5. **Multiple matches — returns all entries in input order.** Three-block
   porcelain; first and third blocks both have `branch refs/heads/feature/44`.
   Assert returns two `WorktreeInfo` entries in encounter order. (`git worktree
   add --force` makes this technically reachable, but the test verifies the
   parser shape, not real-git behavior.)

6. **No matches — returns empty array.** Porcelain has blocks for `main` and
   `feature/77`; query `feature/44`. Assert returns `[]`.

7. **Malformed / non-branch blocks silently skipped.** Porcelain mixes:
   - a normal `worktree + branch` block on `feature/44`
   - a `worktree + detached` block (no `branch` line at all)
   - a block with a malformed `branch refs/tags/v1` line (parser only strips
     `refs/heads/` prefix; this block matches nothing)
   - a stray `garbage line` inside an otherwise-valid block

   Assert returns exactly the one valid `feature/44` entry — the other blocks
   neither produce entries nor cause the parser to throw. AC explicit:
   "malformed lines silently skipped."

Put pure-parser tests in their own `describe("findWorktreesForBranch", ...)`
block; integration tests in `describe("createWorktree", ...)`.

**No real `git` invocations.** Per AC #4. The hand-rolled routing-table mock
is the verification mechanism. Same posture as #19/#35/#36/#37/#43.

**No `child_process` import in `create.ts` OR the test.** Per AC #4. Verified
by inspection (grep `child_process` in both files should be empty).

## Open questions

- **Should `Subprocess` move to a shared module now that it has two callers?**
  Not yet — but the moment is close. Per #43's open-questions paragraph, the
  promotion threshold is the *third* caller. `cleanup.ts` declares the type;
  `create.ts` imports it; that's the second. The launcher's production-wiring
  ticket — which actually implements `Subprocess` over `child_process.spawn` —
  is the third. At that point promote to e.g. `src/worktree/subprocess.ts` (or
  `src/runtime/subprocess.ts` if other directories surface their own subprocess
  callers). Until then, sibling-module imports inside `src/worktree/` are fine
  (CLAUDE.md "no barrels" forbids `src/index.ts` re-exports, not direct sibling
  imports — same precedent as #37 importing `GraphQLTransport` from #19).

- **Should `findWorktreesForBranch` and `findCollidingWorktree` share a
  paragraph-block tokenizer?** No — explicit "while I'm here" refactor.
  Current shapes return different types (string|null vs `WorktreeInfo[]`) and
  match on different fields (path vs branch); a shared `parseBlocks(porcelain)
  → Block[]` helper would be strictly nicer but is out of scope for #44. File
  a follow-up if a third porcelain consumer lands.

- **Should `createWorktree` invoke `removeWorktree` internally on collision?**
  No — explicit AC: "Auto-recovery for collisions … is intentionally NOT in
  this ticket." The dispatch-layer integration (future ticket) composes
  removal-then-create where appropriate; this primitive surfaces collision
  errors verbatim so the integration layer can decide policy (retry vs error
  vs route-back).

- **Should `createWorktree` validate that `repoRoot` exists / is a git repo?**
  No. `git -C <bad-path>` already produces a clear error; wrapping it would
  add a defensive check for a failure mode no caller has demonstrated.
  CLAUDE.md "Don't write a defense for a failure mode that hasn't been
  observed."

- **Should the function accept an opts object (`{ force?, detach?, ... }`)
  for future extensibility?** No — narrow types per #6. Add parameters when
  callers need them; the four-positional-arg shape (`branch, repoRoot,
  worktreeDir, spawn`) matches the AC and is the minimum viable surface.

## File hygiene

- Hardcap 200 lines (`create.ts`). Expected actual: 50–80 production lines
  including the parser and types.
- Hardcap 200 lines (`create.test.ts`). Expected actual: 110–150 lines
  including the copied `makeSpawn` / `ok` / `fail` / `argvEq` helpers and
  fixtures.
- No `process.env` reads. (Per AC #6.)
- No imports from `src/index.ts`. (Per AC #6.)
- No `child_process` import in `create.ts` or `create.test.ts`. (Per AC #4.)
- Module exports: `WorktreeInfo`, `createWorktree`, `findWorktreesForBranch`.
  `Subprocess` / `SubprocessResult` are NOT re-exported — consumers import
  them from `./cleanup.ts` directly (same one-canonical-source posture as
  `RestTransport` and `GraphQLTransport`).
- Header comment ~10 lines: states what the module does (creation primitive +
  pure porcelain parser), what it does NOT decide (collision recovery — that's
  the dispatch layer's concern), and the load-bearing invariant (errors
  surface verbatim).

## Implementation checklist (developer-facing)

1. Write `test/worktree/create.test.ts` covering tests 1–7 above (RED). Copy
   the `makeSpawn` / `ok` / `fail` / `argvEq` helpers verbatim from
   `test/worktree/cleanup.test.ts:1-46`. Reuse the `Subprocess` /
   `SubprocessResult` imports from `cleanup.ts`.
2. Write `src/worktree/create.ts` exporting `WorktreeInfo`, `createWorktree`,
   `findWorktreesForBranch` per § Design. Import `Subprocess` from
   `./cleanup.ts`. Import `resolve` from `node:path`.
3. Confirm tests go GREEN. Run `pnpm typecheck && pnpm test && pnpm lint`. All
   green is the bar.
4. Confirm by grep that `create.ts` and `create.test.ts` do NOT import
   `child_process` (per AC #4) and do NOT read `process.env` (per AC #6).
