# Architecture spec — #45 `src/worktree/codegraph-link.ts`

One pure decision (`decideCodegraphSymlink`) plus one applier
(`applyCodegraphSymlinkActions`) over a narrow filesystem seam, both co-located
in `src/worktree/codegraph-link.ts`. The applier symlinks the canonical
`.codegraph/` index from the target repo into a fresh worktree so dispatched
agents running with the codegraph MCP server can adopt the index. This module
makes no decisions about *which* worktree to link or *when* to link it; the
dispatch layer composes it after `createWorktree` (#44) and before agent spawn.

## Files to read first

The developer's turn-1 reading list. Each entry has a one-line "what to extract."

- `src/worktree/cleanup.ts:1-19` — header-comment style and "what this does NOT decide" framing. Mirror tone/length and the load-bearing-invariant call-out.
- `src/worktree/cleanup.ts:83-91` — **the precedent for keeping a small pure helper next to its applier.** `findCollidingWorktree` lives in `src/worktree/cleanup.ts` rather than in `src/pipeline/` because it's intrinsically coupled to the applier in the same file. Same justification applies to `decideCodegraphSymlink` here — see § "Why collapse pure + applier" below.
- `src/pipeline/blockers.ts:30-39` — pure-parser shape (`parseCommitsAhead` throws on malformed input, exhaustive `switch`, no `default`). `decideCodegraphSymlink`'s `switch` over the state kind mirrors this — TypeScript exhaustiveness check (no `default`) so a future fifth state is a compile error.
- `src/github/labels.ts:25-77` — idempotency-by-precondition shape. The applier mirrors `removeLabel`'s GET-then-PUT-only-if-present pattern: probe state (caller's job), decide (pure function), then mutate only the actions that aren't `noop`.
- `test/worktree/cleanup.test.ts:14-46` — `makeSpawn` recording-mock pattern (`Route` shape, `calls` log, routing-table closure). **Mirror this verbatim** as `makeFs(routes)` retyped to `SymlinkFs`. The `calls`-log is the verification mechanism for the AC's "no real symlinks created" pin (zero spawn → zero fs ops on the host).
- `test/worktree/cleanup.test.ts:133-155` — pure-parser test pattern (`describe` block with no seam, only fixture inputs and return-value assertions). The four pure-decision tests mirror this shape exactly.
- `docs/PROJECT-MEMORY.md` § "src/worktree/ cleanup primitive (#43)" — directory-level patterns: free function over class (no state to bind), narrow DI seams co-located with their first consumer, errors propagate verbatim, narrow types per the #6 ladder.
- `docs/PROJECT-MEMORY.md` § "src/pipeline/ purity (#6)" — narrow-types rule. `CodegraphLinkState` includes only the fields the predicate reads; `SymlinkAction.from`/`to` are minimal. Do NOT widen for hypothetical future consumers.
- `docs/lessons.md` § "`removeLabel` idempotency: GET-then-PUT, not DELETE-with-catch (#36)" — the reasoning behind "probe state first, decide, then mutate" generalizes here. The applier never tries `unlink` speculatively to "fix up" what might be there; the pure function tells it exactly what to do.
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — the rule, plus the precedent in `cleanup.ts` for collapsing small parser+applier pairs.
- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — both `codegraph-link.ts` and the test will land well under 100. Don't expand to fill.
- `CLAUDE.md` § "Test-first" — RED → GREEN → REFACTOR. Failing tests first.
- `CLAUDE.md` § "Belt-and-suspenders" — `allowedTools` granting the codegraph MCP server is the agent-side rule; the symlink applier is the deterministic dispatcher-side safety net behind it. Without the symlink, the agent silently falls back to file-by-file reading and the failure is invisible from the dispatcher's side.

## Context

**Why now.** May 9 lesson: a dispatched agent had the codegraph MCP server in its `allowedTools` but the canonical index lived in the target repo's `.codegraph/`, which wasn't reachable from the worktree. The agent silently fell back to file-by-file reading. The dispatcher's fix is to symlink `<targetRepo>/.codegraph` into `<worktreeRoot>/.codegraph` after `createWorktree` returns and before the agent spawns. Without this seam being load-bearing in code, the next refactor that "cleans up" the symlink call would silently regress codegraph adoption — and the failure mode (agent ignores codegraph) is invisible from the dispatcher's side.

**Why split decision from applier.** Per CLAUDE.md "Pure functions in `src/pipeline/`, I/O at the edges": the decision (which symlink to create, repair, or skip) is testable without touching disk. Tests on the pure function exhaustively cover the four state cases without per-test fs setup; the applier's tests then only need to verify "actions get applied to the seam" rather than re-deriving the decision logic.

**Why an internal `noop` action carrying a `target-missing` reason.** The PO's technical note: "not every target repo has a codegraph index, and the dispatcher must not crash when it's absent." Surfacing this as a non-error `noop` (rather than throwing) lets the caller log-and-continue without re-deriving the branch. Same shape rule as `mergePr`'s typed `{ merged: false, reason: "conflict" | "other" }` (#41) — when a wrapper's failure has a structured downstream consequence (here: log a "no index" warning) AND the failure mode is detectable from the state, surface it as a typed return rather than a throw.

**What this is not.** This module does NOT inspect the filesystem to compute the state — that's the dispatch-layer integration's concern (separate, future ticket). It does NOT decide *which* worktrees get codegraph links — the dispatch layer makes that call. It does NOT prune broken symlinks left over from an out-of-band index relocation — the AC covers `present-wrong-target` (link points somewhere stale) but not `target-of-existing-link-vanished`; that case ladders in only when observed.

## Design

### Why collapse pure + applier into one file

Per CLAUDE.md the pure function's canonical home is `src/pipeline/codegraph-link.ts`. PO's AC explicitly green-lit collapsing into `src/worktree/codegraph-link.ts` if the function is small enough that the split adds more friction than it removes — and asked architect to call it explicitly either way.

Collapse, for three reasons:

1. **Precedent in `cleanup.ts` (#43).** `findCollidingWorktree` is pure (string in, string-or-null out), takes no I/O, and lives in `src/worktree/` next to its sole consumer (`removeWorktree`). The same justification applies here: `decideCodegraphSymlink` is intrinsically coupled to `applyCodegraphSymlinkActions` in the same file — there's no second consumer, and the pure function's output shape (`SymlinkAction[]`) is structurally a worktree concern, not a pipeline concern.
2. **Both halves are tiny.** Pure decision: ~15 lines. Applier: ~10 lines. Splitting into `src/pipeline/codegraph-link.ts` (15 lines + types) and `src/worktree/codegraph-link.ts` (10 lines + import-and-re-export-types) creates two files that together are smaller than `cleanup.ts`. The friction (cross-package import, two files to navigate, two test files) outweighs the purity benefit when the pure function has exactly one consumer in the same directory.
3. **Future consumers of `decideCodegraphSymlink` would still live in `src/worktree/`** (any other "link an external dir into a worktree" use case is structurally a worktree concern). If a non-worktree consumer ever appears, promote `decideCodegraphSymlink` to `src/pipeline/codegraph-link.ts` then — same one-shared / second-imports / third-promotes ladder as `Subprocess` (#43 → #44) and the three flavours of `Agent`.

### Module shape

```ts
// src/worktree/codegraph-link.ts

import { posix as path } from "node:path";

// The four states the pure decision discriminates. Computed at the dispatch
// callsite by inspecting (a) whether <worktreeRoot>/.codegraph exists and
// what (if anything) it points to, and (b) whether the target .codegraph
// exists. Per the #6 narrow-types rule, this type carries only the fields
// the predicate reads — no fs.Stats, no error chains, no actualLinkTarget
// for non-wrong-target branches.
export type CodegraphLinkState =
  | { readonly kind: "absent" }
  | { readonly kind: "present-correct" }
  | { readonly kind: "present-wrong-target"; readonly currentTarget: string }
  | { readonly kind: "target-missing" };

// Named constants for the `noop` reasons. Callers branch on these (e.g. log
// "no codegraph index in target repo" vs nothing at all) without re-deriving
// the branch. AC #3 explicitly calls out "or equivalent named constant" for
// the target-missing case.
export const NOOP_TARGET_MISSING = "target-missing";
export const NOOP_ALREADY_CORRECT = "already-correct";

export interface SymlinkAction {
  readonly kind: "create" | "repair" | "noop";
  readonly from: string;  // canonical .codegraph path (link target)
  readonly to: string;    // <worktreeRoot>/.codegraph (link path)
  readonly reason?: string;
}

export interface DecideCodegraphSymlinkInput {
  readonly worktreeRoot: string;
  readonly targetCodegraphPath: string;
  readonly state: CodegraphLinkState;
}

// Pure. No await, no fs, no env. Always returns a 1-element array today;
// the array shape leaves room for "decide several symlinks" futures
// without rewriting the contract.
export function decideCodegraphSymlink(
  input: DecideCodegraphSymlinkInput,
): SymlinkAction[];

// DI seam — narrow `Fs` shape with the two operations the applier needs.
// Per the #6 narrow-types rule + the `Subprocess` / `RestTransport` /
// `GraphQLTransport` precedent: each I/O boundary owns its narrow type for
// its narrow concern. Co-located here until a second caller appears.
export interface SymlinkFs {
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

// Applier. Walks the action list and applies each non-noop action via the
// seam. Errors propagate verbatim — no try/catch, no swallowing, no
// fallback retry. A failure mid-list aborts the remaining actions; today
// the list is always 1 element so this is moot, and the dispatch layer is
// the right place to add multi-action recovery if it ever matters.
export async function applyCodegraphSymlinkActions(
  actions: readonly SymlinkAction[],
  fs: SymlinkFs,
): Promise<void>;
```

Six exports (`CodegraphLinkState`, `NOOP_TARGET_MISSING`, `NOOP_ALREADY_CORRECT`, `SymlinkAction`, `DecideCodegraphSymlinkInput`, `decideCodegraphSymlink`, `SymlinkFs`, `applyCodegraphSymlinkActions`) — over the 5-export red line by name count, but five of those are types/constants (zero runtime weight, zero refactor surface beyond renames). The two functions are the API. This is the same shape as `cleanup.ts` (4 named exports + 1 file-private), well within scale.

### `decideCodegraphSymlink` — the four-row table

| `state.kind` | Output |
|---|---|
| `target-missing` | `[{ kind: "noop", from, to, reason: NOOP_TARGET_MISSING }]` |
| `absent` | `[{ kind: "create", from, to }]` |
| `present-correct` | `[{ kind: "noop", from, to, reason: NOOP_ALREADY_CORRECT }]` |
| `present-wrong-target` | `[{ kind: "repair", from, to }]` |

Implementation: exhaustive `switch` with no `default`, mirroring `shouldProduceCommits` in `blockers.ts:53-60`. A future fifth state is a compile error rather than a silent missing-row.

```ts
export function decideCodegraphSymlink(input: DecideCodegraphSymlinkInput): SymlinkAction[] {
  const to = path.join(input.worktreeRoot, ".codegraph");
  const from = input.targetCodegraphPath;
  switch (input.state.kind) {
    case "target-missing":
      return [{ kind: "noop", from, to, reason: NOOP_TARGET_MISSING }];
    case "absent":
      return [{ kind: "create", from, to }];
    case "present-correct":
      return [{ kind: "noop", from, to, reason: NOOP_ALREADY_CORRECT }];
    case "present-wrong-target":
      return [{ kind: "repair", from, to }];
  }
}
```

`node:path/posix.join` is a pure string function — fine to import in a pure file. POSIX semantics (`/` separator) are correct: dispatcher worktrees are Unix-only (the agents repo dispatches against this repo on macOS/Linux). Do NOT use `node:path` (platform-conditional) — POSIX is deterministic.

`from` (link target) and `to` (link path) ordering follows POSIX `symlink(2)`: the first argument is what the link points TO (target), the second is the link's own path (linkpath). This is also `node:fs/promises.symlink(target, path)`'s argument order. Pin the naming explicitly: `from` = "where the link points" = "what we're pointing AT" = the existing `.codegraph` directory; `to` = "where the link lives" = the new entry inside the worktree. The applier passes `(action.from, action.to)` directly to `fs.symlink` with no swap.

### `applyCodegraphSymlinkActions` — apply, don't decide

```ts
export async function applyCodegraphSymlinkActions(
  actions: readonly SymlinkAction[],
  fs: SymlinkFs,
): Promise<void> {
  for (const action of actions) {
    if (action.kind === "noop") continue;
    if (action.kind === "repair") await fs.unlink(action.to);
    await fs.symlink(action.from, action.to);
  }
}
```

`repair` is `unlink` + `symlink` (two seam calls). `create` is `symlink` only. `noop` is zero. There is no `unlink`-only branch today — `target-missing` plus a stale link is out of scope per § Context "What this is not."

Errors propagate verbatim per the `labels.ts` / `cleanup.ts` posture. A `repair` whose `unlink` succeeds but whose `symlink` fails leaves the worktree without a `.codegraph` entry; the dispatch layer is the right place to surface that as a re-runnable state (the next dispatch cycle will see `state.kind === "absent"` and re-create). No internal try/catch.

### Why a fresh `SymlinkFs` seam, not a reuse

Same justification as `Subprocess` in #43:

| Seam | Shape | Why distinct |
|---|---|---|
| `RestTransport` | `(method, path, body) => unknown` | HTTP. |
| `GraphQLTransport` | `(query, variables) => unknown` | GraphQL. |
| `Subprocess` | `(argv) => { exitCode, stdout, stderr }` | Argv-shell. |
| `SymlinkFs` | `{ symlink(target, path), unlink(path) }` | Filesystem ops. |

Each I/O boundary owns its narrow type. `SymlinkFs` could in principle be modelled as a callable (`(op, args) => Promise<void>`) but that loses TypeScript's parameter typing per op. The two-method object shape matches `node:fs/promises`'s actual surface — production wiring is one line: `applyCodegraphSymlinkActions(actions, fs.promises)`. Tests hand-roll a routing-table fake, no `vi.mock`, no `as any`, no inheritance.

The `SymlinkFs` interface uses bare method names matching `node:fs/promises` so the production wiring is a free pass-through. The test fake implements the same shape with a `calls` log.

### State probe (out of scope today)

The pure function takes a pre-computed `CodegraphLinkState`. Computing it requires probing the filesystem:

- `fs.lstat(<worktreeRoot>/.codegraph)` — does the entry exist? Is it a symlink?
- `fs.readlink(<worktreeRoot>/.codegraph)` — what does it point to (for symlinks)?
- `fs.access(<targetCodegraphPath>)` — does the target index exist?

This probe is the dispatch-layer integration's concern, not this module's. It can land as a third helper in `codegraph-link.ts` later — `inspectCodegraphLink(worktreeRoot, targetCodegraphPath, fs): Promise<CodegraphLinkState>` — keeping the file under the 200-line cap. **For #45 we land only the pure decision and the applier.** The dispatch-layer ticket that wires this up will add the probe at that time and supply the state input from real fs reads. Do NOT speculate on the probe's signature now — see CLAUDE.md "Don't write a defense for a failure mode that hasn't been observed."

## Concurrency model

Single-call serial — no parallel symlinks. The applier walks the action list with sequential `await`s. Each step depends on the previous step's outcome (a `repair`'s `symlink` only runs if its `unlink` succeeded). No `Promise.all` opportunity.

The dispatcher's loop layer is the concurrency owner; this module's calls serialize within one dispatch's worktree-setup phase. Two simultaneous applier calls against the same worktree path would race, but that's a higher-level invariant — one worktree per dispatch, dispatches don't overlap on the same path.

## Error handling

| Failure | Behaviour |
|---|---|
| Pure decision: malformed `state.kind` (TS-impossible) | TS exhaustiveness check; runtime would `return undefined` in the impossible case, but the closed `kind` union plus the `switch` makes this unreachable. |
| Applier: `fs.unlink` rejects on `repair` | Propagates verbatim. The worktree's stale link survives; next dispatch's probe will see `present-wrong-target` again. |
| Applier: `fs.symlink` rejects on `create` | Propagates verbatim. The worktree has no `.codegraph` entry; next probe sees `absent`. |
| Applier: `fs.symlink` rejects on `repair` *after* `fs.unlink` succeeded | Propagates verbatim. The worktree has no `.codegraph` entry; next probe sees `absent`. The window of "stale link removed but new link not yet created" is the cost of repair-as-unlink-then-symlink; an atomic-rename approach (`symlink → tmp, rename(tmp, real)`) is a future hardening, not in scope. Per CLAUDE.md "Don't write a defense for a failure mode that hasn't been observed." |
| `SymlinkFs` itself rejects with anything | Propagates verbatim. Same posture as `Subprocess` rejection in #43. |

`stderr`-style trimming (as in `cleanup.ts`) is N/A — this module doesn't construct error messages from subprocess output. Errors come straight from the seam.

## Testing strategy

File: `test/worktree/codegraph-link.test.ts`. Two `describe` blocks:

1. `describe("decideCodegraphSymlink", ...)` — pure-decision tests; no seam, no fixtures beyond input objects.
2. `describe("applyCodegraphSymlinkActions", ...)` — applier tests; routing-table `SymlinkFs` fake mirroring `makeSpawn` from `test/worktree/cleanup.test.ts:14-46`.

### `makeFs` recording fake

```ts
type FsRoute =
  | { op: "symlink"; match: (target: string, path: string) => boolean; respond?: () => void | Promise<void> }
  | { op: "unlink"; match: (path: string) => boolean; respond?: () => void | Promise<void> };

interface RecordingFs {
  fs: SymlinkFs;
  calls: Array<["symlink", string, string] | ["unlink", string]>;
}

function makeFs(routes: readonly FsRoute[]): RecordingFs {
  const calls: RecordingFs["calls"] = [];
  const fs: SymlinkFs = {
    symlink: async (target, p) => {
      calls.push(["symlink", target, p]);
      for (const r of routes) if (r.op === "symlink" && r.match(target, p)) return r.respond?.();
      throw new Error(`No route matched: symlink(${target}, ${p})`);
    },
    unlink: async (p) => {
      calls.push(["unlink", p]);
      for (const r of routes) if (r.op === "unlink" && r.match(p)) return r.respond?.();
      throw new Error(`No route matched: unlink(${p})`);
    },
  };
  return { fs, calls };
}
```

Mirrors `makeSpawn` (`test/worktree/cleanup.test.ts:26-34`) but with two op kinds. The `calls` log is the verification mechanism for "no real symlinks created" — every fs op flows through this in-memory fake; no `node:fs` import in the test.

### Pure-decision tests (AC #3)

The four cases exhaust the closed state union, so this `describe` block is exactly four `it`s. Mirror the table in § Design verbatim. Use a fixed input fixture for `worktreeRoot` and `targetCodegraphPath`:

```ts
const WORKTREE_ROOT = "/tmp/.pyrycode-worktrees/dev-45";
const TARGET_CODEGRAPH = "/Users/foo/repo/.codegraph";
const EXPECTED_TO = "/tmp/.pyrycode-worktrees/dev-45/.codegraph";
```

1. **`absent` → single `create` action.** Input `{ state: { kind: "absent" } }`. Assert: returns `[{ kind: "create", from: TARGET_CODEGRAPH, to: EXPECTED_TO }]` (deep-equals; no `reason`).
2. **`present-correct` → single `noop` with `NOOP_ALREADY_CORRECT` reason.** Deep-equals the full action including `reason: NOOP_ALREADY_CORRECT`. **Pin the named constant**, not the string literal `"already-correct"` — a future rename of the constant would break this assertion if it didn't also update the test, which is the regression guard against constant drift.
3. **`present-wrong-target` → single `repair` action.** Input `{ state: { kind: "present-wrong-target", currentTarget: "/some/old/path" } }`. Assert: returns `[{ kind: "repair", from: TARGET_CODEGRAPH, to: EXPECTED_TO }]`. The `currentTarget` is in the input (so the caller's probe doesn't have to discard it), but is NOT echoed in the output — the applier doesn't need it (it `unlink`s the path, not the target). Pin this absence: `expect(result[0]).not.toHaveProperty("currentTarget")`.
4. **`target-missing` → single `noop` with `NOOP_TARGET_MISSING` reason.** Deep-equals the full action including `reason: NOOP_TARGET_MISSING`. Pin the named constant per #2's reasoning. This is the AC's "carrying a `reason: 'target-missing'` (or equivalent named constant) so the caller can log/skip without re-deriving the branch" line — verified by the constant pin.

Add a fifth assertion **outside the four-case block** that pins the closed-union exhaustiveness shape: a TS-only assertion (`const _: never = state` inside an unreachable branch) is the standard pattern, but since exhaustive `switch` over a string-literal kind already produces a TS error on missing rows, the existing `switch` IS the assertion. No runtime test needed; document this in the implementation comment per the `shouldProduceCommits` precedent (`blockers.ts:53-60`).

### Applier tests (AC #4 — DI'd in-memory fake, NO real symlinks)

1. **`create` action → single `symlink` call.** One route: `{ op: "symlink", match: (t, p) => t === FROM && p === TO, respond: () => {} }`. Pass `[{ kind: "create", from: FROM, to: TO }]`. Assert: `calls.length === 1`; `calls[0]` deep-equals `["symlink", FROM, TO]`.
2. **`repair` action → `unlink` then `symlink`, in that order.** Two routes (one per op). Pass `[{ kind: "repair", from: FROM, to: TO }]`. Assert: `calls.length === 2`; `calls[0]` deep-equals `["unlink", TO]`; `calls[1]` deep-equals `["symlink", FROM, TO]`. **Order is load-bearing** — symlinking before unlinking would `EEXIST` on a real fs; the test pins the sequence even though the in-memory fake won't catch it. Same posture as #19's "Native ordering, never derived from `issueNumber`" assertion — pin the ordering invariant explicitly.
3. **`noop` action → zero fs calls.** No routes registered (any call would hit `No route matched: ...` and fail the test). Pass `[{ kind: "noop", from: FROM, to: TO, reason: NOOP_TARGET_MISSING }]`. Assert: `calls.length === 0`. **Load-bearing pin** — same shape as `cleanup.test.ts`'s "already-absent — zero subprocess calls" assertion (`test/worktree/cleanup.test.ts:67-77`). A future "always log/probe even on noop" simplification would still satisfy "no throw" but fails this count.
4. **Multi-action list applies each in order.** Pass `[{kind:"noop",...}, {kind:"create",...}]`. Assert: `calls.length === 1` (only the `create`); `calls[0][0] === "symlink"`. Verifies the loop body's `noop`-skip predicate doesn't accidentally short-circuit subsequent actions. Today the list is always 1 element from the pure function, but the contract is "applies each in order" — pin it.
5. **`symlink` rejection propagates verbatim.** One route: `{ op: "symlink", match: () => true, respond: () => { throw new Error("CANARY: EACCES"); } }`. Pass `[{ kind: "create", from: FROM, to: TO }]`. Assert: `applyCodegraphSymlinkActions(...)` rejects with an Error whose `.message` contains `"CANARY: EACCES"`. Mirrors `cleanup.test.ts`'s "list fails — surfaces stderr verbatim" pattern (lines 101-130) and `labels.test.ts`'s "transport-failure THROWS" pattern.

**No real `node:fs` import in the test.** Per AC #4. Verify by inspection (grep `node:fs` and `"fs"` imports in `test/worktree/codegraph-link.test.ts` should be empty). The recording-table fake is the only fs surface.

**No `process.env` reads anywhere.** Per AC #5. Verify by inspection.

## Open questions

- **Should the state probe (`inspectCodegraphLink`) land in this ticket?** No. AC scope is `decide` + `apply`. The probe lives at the dispatch-layer integration ticket where it has a real callsite to constrain its signature. Adding it now speculates on the wiring (does it take an `Fs` seam wider than `SymlinkFs`? does it return `CodegraphLinkState` or a richer shape?). Resolved: out of scope.

- **Should `SymlinkFs` be promoted to a shared module (e.g. `src/runtime/fs.ts`)?** Not yet. Per the #6 narrow-types ladder + the `Subprocess` precedent: co-locate on the first lander (here), import from sibling on the second, promote on the third. Resolved: co-located.

- **Should `SymlinkAction` be a discriminated union in TypeScript (e.g. `{ kind: "create"; from; to } | { kind: "noop"; from; to; reason }`) instead of the flat shape with optional `reason`?** The AC's example shape is flat (`{ kind, from, to, reason? }`) and the runtime check on `kind` in the applier doesn't benefit from narrowing (we never read `reason` in the applier). Flat shape matches the AC's wording exactly and keeps the type surface minimal. Resolved: flat.

- **Should the array shape be reduced to a single `SymlinkAction` since today there's always one?** No. The AC explicitly says "Output is a list of `{ kind: ... }` actions." Returning a single value would break the contract; widening later would require updating every callsite. Cost of `[action]` over `action` is negligible (one `[0]` index at the callsite). Resolved: array per AC.

- **Should `NOOP_ALREADY_CORRECT` be optional (omit `reason` for `present-correct` since the caller doesn't usually need it)?** Both the `target-missing` and `present-correct` cases benefit from a named constant — callers may want to differentiate "no index in target repo, this is fine" from "already linked, nothing to do." The AC's "(or equivalent named constant)" phrasing is for `target-missing` specifically, but applying it to both reasons is the consistent shape. Cost is one extra exported constant; benefit is callers don't substring-match a string literal. Resolved: both reasons named.

## File hygiene

- Hardcap 200 lines (`src/worktree/codegraph-link.ts`). Expected actual: 50–80 production lines including types and the named-constant exports.
- Hardcap 200 lines (`test/worktree/codegraph-link.test.ts`). Expected actual: 100–140 lines including the `makeFs` helper and fixtures.
- No `process.env` reads.
- No imports from `src/index.ts`.
- No `node:fs` / `node:fs/promises` import in `codegraph-link.ts` (the production wiring of `SymlinkFs` lives at the dispatch-layer integration ticket — `codegraph-link.ts` only declares the interface and consumes it).
- No `node:fs` / `node:fs/promises` import in `codegraph-link.test.ts` (per AC #4).
- `node:path` IS allowed in `codegraph-link.ts` — used as `import { posix as path }` for pure string path-joining. Pure function, deterministic, no I/O.
- Module exports: `CodegraphLinkState`, `NOOP_TARGET_MISSING`, `NOOP_ALREADY_CORRECT`, `SymlinkAction`, `DecideCodegraphSymlinkInput`, `decideCodegraphSymlink`, `SymlinkFs`, `applyCodegraphSymlinkActions`. No file-private helpers expected (the function bodies are small enough).
- Header comment ~10 lines: states what the module does (decide + apply codegraph symlinks for fresh worktrees), what it does NOT decide (which worktree to link, when to link it, how to probe state), and the load-bearing belt-and-suspenders invariant (deterministic safety net behind the `allowedTools` MCP-server grant).

## Implementation checklist (developer-facing)

1. Create `test/worktree/codegraph-link.test.ts` first (RED). Two `describe` blocks: pure-decision (4 `it`s) and applier (5 `it`s). Use `makeFs` recording fake mirroring `makeSpawn` from `test/worktree/cleanup.test.ts:26-34`. Tests reference exports that don't exist yet — they should fail to compile.
2. Create `src/worktree/codegraph-link.ts` (GREEN). Implement per § Design's module shape and the four-row `switch` table. The applier's loop body is `if noop continue; if repair await unlink; await symlink`.
3. Confirm by grep that `codegraph-link.test.ts` imports neither `node:fs` nor `"fs"`. Confirm `codegraph-link.ts` imports neither (only `node:path` is allowed).
4. Confirm no `process.env` reads in either file.
5. Run `pnpm typecheck && pnpm test && pnpm lint`. All green is the bar.
