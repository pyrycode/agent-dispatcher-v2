# Spec: `src/claude/jsonl.ts` — extract last N assistant messages from session JSONL on disk (#61)

## Files to read first

- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — sets the file-size ceiling repeated in the ticket AC.
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — `src/claude/jsonl.ts` is an I/O-edge module (it reads from disk), so it lives under `src/claude/` and is allowed to `await` `fs.readFile`. The parse step inside it is pure but stays inlined (no premature extraction to a shared helper — see Design § Reuse).
- `CLAUDE.md` § "Don't" — bullets "Don't write a defense for a failure mode that hasn't been observed" (constrains error handling to malformed-line skipping only) and "Don't import from a barrel file" (no `src/index.ts` re-export).
- `CLAUDE.md` § "Test-first" — RED → GREEN → REFACTOR is mandatory; fixture-driven assertion comes before the parser.
- `src/claude/stream.ts:34-86, 106-127` — the sibling parser. Shape of the `extractAssistantText` helper and the malformed-line-skipping loop are the prior art this file mirrors (deliberately duplicated, not shared — see Design § Reuse).
- `test/claude/stream.test.ts:1-12, 97-131` — fixture-loading shape (`readFileSync` + `join(__dirname, "..", "fixtures", "claude-<dir>")`) and the malformed-line edge-case patterns this test reuses.
- `docs/specs/architecture/9-claude-stream.md` § "Out of scope" bullet "Capturing fixtures from sources other than the Claude CLI's `--output-format stream-json`" — explicitly deferred session-JSONL parsing to a follow-up. This is that follow-up; the two parsers stay separate by design.
- `docs/lessons.md` (entire file, 88 lines) — for the regression-fixture posture (observed bug → permanent fixture + non-empty assertion), specifically the framing the ticket body invokes: PR #138's `**Last messages**` shipped empty because tests asserted "no throw" instead of "non-empty output."
- `biome.json:5-19` — formatter rules (double quotes, trailing commas all, semicolons always, 100-col line width).

## Context

When the dispatcher salvages a `max_turns` run, it opens a draft PR with the agent's most recent reasoning quoted into the body — the human triaging the recovery needs that context without re-reading the full transcript. Claude persists its session JSONL on disk at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (the ticket body cites a `sessions/` subdirectory; the actual on-disk layout is the project dir's top level — this function takes a path argument, so the directory layout isn't its concern). `extractLastMessages(jsonlPath, n)` is the read-and-extract step.

v1's analogous code shipped a bug on PR #138 (2026-05-03): the extractor read the wrong field shape and the salvage PR's `**Last messages from the agent:**` section landed empty. Tests covering it asserted only "the function does not throw" — never "the output is non-empty." Per `docs/lessons.md`'s regression-fixture posture, the fix-forward contract is: a real captured session JSONL must drive an assertion that explicitly pins non-empty output.

### Why this is a separate parser from `stream.ts`

The two surfaces look similar but consume distinct shapes:

- `stream.ts` parses `claude -p --output-format stream-json` stdout — top-level message types are `"system"` (init), `"assistant"`, `"result"`. No `parentUuid`, no `sessionId` envelope field, no `timestamp`.
- This file parses the on-disk session JSONL — top-level types include `"queue-operation"`, `"user"`, `"assistant"`, with envelope fields `parentUuid`, `sessionId`, `timestamp`. There is no `"result"` line (the session log persists across runs; the run-completion summary is a stream-json artifact, not a session-file artifact).

`stream.ts`'s `parseStream` extracts five things (cost, sessionId, last message, last N, exitReason). This module extracts exactly one: the last N assistant text messages. Forcing one parser to handle both shapes would either complect two output contracts behind one function, or push session-vs-stream discrimination into a caller that has no business knowing about it. Two small parsers, one per shape — see Design § Reuse for why the ~10-line `extractAssistantText` helper stays duplicated rather than shared.

## Design

### File: `src/claude/jsonl.ts`

Single new file. One exported async function (`extractLastMessages`). No exported types. Estimated 30–45 production lines; well under the 200-line hardcap.

#### Public signature

```ts
import { readFile } from "node:fs/promises";

export async function extractLastMessages(
  jsonlPath: string,
  n: number,
): Promise<string[]>;
```

- **Input.** Absolute path to a session JSONL file; `n` is the cap on returned messages.
- **Output.** Array of assistant text strings, oldest first (chronological), at most `n` entries. Empty array if no assistant text blocks are found. If the file contains fewer than `n` assistant text messages, all of them are returned — no padding, no throw (AC).
- **Async, not pure.** Returns `Promise<string[]>`. The `node:fs/promises` `readFile` call is the I/O edge.

No `ExtractOpts` struct, no return-object struct. `n` is a single scalar; the return is a flat string array shaped exactly to what salvage's PR-body builder will quote. If a future surface needs richer per-message metadata (timestamp, parentUuid), add a sibling export rather than widening this function's contract — keep this one narrow.

#### Parse loop

1. `const raw = await readFile(jsonlPath, "utf8");`
2. Split `raw` on `/\r?\n/`.
3. For each line:
   - `if (line.trim() === "")` → skip.
   - `try { parsed = JSON.parse(line) } catch { continue; }` — malformed / partial lines are skipped silently (AC: extractor never throws on a mid-file parse error). Matches `stream.ts`'s posture exactly.
   - If `parsed` is not a plain object, skip.
   - If `parsed.type !== "assistant"`, skip. (This filters out `"queue-operation"`, `"user"`, and any other envelope type — AC: only assistant-role messages appear in the output.)
   - Walk `parsed.message.content[]`: for each block where `block.type === "text"` and `typeof block.text === "string"` and `block.text.length > 0`, append `block.text` to a running `texts: string[]`.
4. Return `texts.slice(-Math.max(0, n))`.

The `Math.max(0, n)` guard mirrors `stream.ts:74` and tolerates a caller passing `n === 0` (returns `[]`) or a negative `n` (clamps to 0). Not a defense-in-depth flourish — it's the same line `stream.ts` already ships, kept for consistency. No `Number.isFinite` / range validation beyond that; the caller is internal.

#### Reuse: deliberately duplicated, not shared

`stream.ts` already has an internal `extractAssistantText` helper that does the same "walk `.message.content[]`, take `text` blocks" work. The temptation is to lift it to a shared module (`src/claude/messages.ts` or similar) and import from both files.

Don't. Three reasons:

1. **CLAUDE.md "Three similar lines is better than a premature abstraction."** The helper is ~10 lines. Lifting it adds a third file, a new export surface, and an import edge — for a single duplication. The shared-abstraction tax is paid up front; the duplication tax is paid only when a third consumer arrives.
2. **The two parsers' invariants differ subtly.** `stream.ts` knows top-level `type === "assistant"` implies `.message.role === "assistant"`. The session file's `"assistant"` envelopes carry the same redundancy, but a future SDK change could decouple them on one surface without touching the other. Each parser owning its own narrowing means a wire-format drift on one side can't silently propagate.
3. **#9's precedent.** `docs/specs/architecture/9-claude-stream.md` § "Internal helpers" set the rule: helpers stay unexported until a second consumer appears in the *same module's idiom*. This file is a different idiom (async/IO vs pure/string-in); it's not "a second consumer of `extractAssistantText`" — it's a parallel parser that happens to share a sub-step.

If a third consumer appears (e.g. an MCP-resources reader that walks session JSONL with a different output shape), reconsider extraction at that point — three consumers is when the abstraction earns its keep.

#### Behavioural matrix (AC-anchored)

| Input shape | Output |
|---|---|
| Real captured session JSONL, `n` ≥ count of assistant text blocks | All blocks, oldest-first |
| Real captured session JSONL, `n` < count | Last `n` blocks, oldest-first |
| File with `user`/`queue-operation`/`tool_use`/`tool_result` lines, no `assistant` text | `[]` |
| Mid-file partial JSON (last line truncated) | Complete prior lines parsed; partial skipped; no throw |
| `n === 0` | `[]` |

### File: `test/claude/jsonl.test.ts`

Mirrors the source path. Vitest, RED-first.

Fixture lives at `test/fixtures/claude-jsonl/session.jsonl`, captured verbatim from a real `~/.claude/projects/<encoded-cwd>/<id>.jsonl` file. AC explicitly forbids hand-editing.

Test rows (one `it` per assertion row, one `describe` per group):

1. **Captured-fixture regression pin** (the load-bearing test — pins PR #138's failure mode):
   - `extractLastMessages(fixturePath, 5)` returns a non-empty array. AC: this is the bullet that PR #138 missed.
   - Every element is a `typeof === "string"` and `.length > 0`.
   - No element contains a JSON serialization of a tool-use block (i.e. the result is text only, not stringified content blocks). Pinned by asserting no element starts with `{"type":"tool_use"` or similar — a coarse contains-check is sufficient; this is the leak shape, not a deep schema check.

2. **`n` smaller than available** (chronological-order pin):
   - With a synthetic 3-message JSONL (assistant lines emitting `"first"`, `"middle"`, `"last"`), `extractLastMessages(path, 2)` returns `["middle", "last"]`. Oldest-first within the slice.
   - With the same fixture, `extractLastMessages(path, 1)` returns `["last"]`.

3. **`n` larger than available** (AC: no padding, no throw):
   - With the 3-message fixture, `extractLastMessages(path, 10)` returns `["first", "middle", "last"]` — length 3, no throw, no `undefined` padding.

4. **Non-assistant lines filtered** (AC: only `assistant`-role messages leak through):
   - Synthetic JSONL containing one `"queue-operation"` line, one `"user"` line, one `"assistant"` line with a single text block. Result is the assistant's text only — length 1.
   - Synthetic JSONL where an `"assistant"` line's content array contains a `tool_use` block followed by a `text` block. Result contains only the text block's string.

5. **Malformed-line tolerance** (AC: never throws on mid-file parse error):
   - Synthetic JSONL with a valid `"assistant"` line, a truncated `'{"type":"asssis'` partial line, and a second valid `"assistant"` line. Result is the two complete texts, in order, no throw.
   - Empty file → `[]`, no throw.

6. **`n === 0` edge** (clamp behaviour, mirrors `stream.ts`'s posture):
   - With the 3-message fixture, `extractLastMessages(path, 0)` returns `[]`.

Test groups 2–6 use small synthetic JSONL files built inline (Node `tmp` dir + `writeFile`, or `fs.writeFileSync` in a `beforeAll`). Group 1 uses the captured fixture only. The synthetic-vs-captured split keeps the captured fixture as the single regression artifact for PR #138 and lets the structural assertions run against minimal inputs without depending on a multi-thousand-line capture.

Inline synthesis is not "hand-editing a real fixture" — the AC's verbatim rule applies only to the captured `session.jsonl`, which group 1 reads unchanged. Synthetic JSONL in groups 2–6 is authored in-test (the test source declares the lines as JS objects, `JSON.stringify`s them, joins with `\n`, writes to a tmp file). Same pattern as `stream.test.ts:133-194` for the `lastN behaviour` group.

### Fixture capture

`test/fixtures/claude-jsonl/session.jsonl` is captured by copying one real session file verbatim. Recommended procedure:

```
# Pick a recent session that has multiple assistant text messages.
ls -lt ~/.claude/projects/-Users-juhanailmoniemi-Workspace-Projects--pyrycode-worktrees-architect-50/*.jsonl | head -3
# Copy whichever has >= 5 assistant text blocks (verify with the jq snippet below).
cp <chosen-path> test/fixtures/claude-jsonl/session.jsonl
# Sanity check:
grep '"type":"assistant"' test/fixtures/claude-jsonl/session.jsonl \
  | jq -c '[.message.content[]? | select(.type=="text") | .text]' \
  | grep -v '^\[\]$' | wc -l   # expect >= 5
```

The file is checked in as inert captured data (no edits, no redaction). If a session contains content the human capturing it deems sensitive, pick a different session — do **not** hand-edit lines (it would invalidate the verbatim-capture AC and contaminate the regression contract).

Session JSONL files used in v1 dispatcher work were a few hundred KB typical, a few MB tail. The fixture should sit comfortably in the test repo; if a chosen capture is unusually large (>1 MB), prefer one of the dispatcher-agent runs at `~/.claude/projects/-Users-juhanailmoniemi-Workspace-Projects--pyrycode-worktrees-architect-*/`, which are bounded by the 50-turn budget.

### Implementation order (RED → GREEN, per AC)

1. `mkdir -p test/fixtures/claude-jsonl test/claude` (the `src/claude/` and `test/claude/` directories already exist from #9).
2. Capture `test/fixtures/claude-jsonl/session.jsonl` per § "Fixture capture". Sanity-check that the captured file contains ≥ 5 assistant text blocks (the regression test asserts non-empty for `n=5`; ≥ 5 ensures the slice is full).
3. Write `test/claude/jsonl.test.ts` with all six assertion groups. Run `pnpm test` → fails (source file does not exist). RED.
4. Write `src/claude/jsonl.ts`. Run `pnpm test` → passes. GREEN.
5. Run `pnpm typecheck && pnpm lint` → both pass.
6. Commit spec + source + tests + fixture together.

If step 4 reveals the captured fixture's field shape disagrees with the design (e.g. content blocks under `.message.content[]` were renamed), update both the design and the parser to match the captured reality. The **fixture is the source of truth**.

### Files touched

- `src/claude/jsonl.ts` — new, ~30–45 lines
- `test/claude/jsonl.test.ts` — new, ~80–110 lines (one `it` per assertion row across six groups)
- `test/fixtures/claude-jsonl/session.jsonl` — captured data, verbatim

No edits to existing files. No `src/index.ts` re-export.

## Concurrency model

None for the parser itself: one `await readFile` then synchronous iteration over the lines. The function is reentrant (no module-level state); two concurrent calls against different paths produce two independent results. Callers concurrent on the *same* path get correct results too, because `readFile` returns a snapshot at the time of the call — neither writer.

The downstream caller (`src/salvage/`) is expected to call this once per recovery event. No streaming, no incremental parsing; session JSONL files are small enough in practice (per ticket Technical Notes).

## Error handling

- **Malformed JSON line in the middle of the file**: skipped silently. AC bullet 2.
- **Truncated final line** (writer killed mid-write): same as above — `JSON.parse` throws, the line is skipped, prior complete lines are kept. The behaviour matches `stream.ts`.
- **File does not exist / permission denied**: `readFile` rejects with the underlying Node error. The function does **not** catch and convert to `[]`.
  - Rationale: per CLAUDE.md "Don't write a defense for a failure mode that hasn't been observed," the only observed regression (PR #138) was an empty-output bug, not a missing-file bug. The caller (`src/salvage/`, not yet built) is responsible for verifying the path exists before calling — that's the right layer for path validation, because salvage owns the discovery of which session file corresponds to which run.
  - If a future ticket shows a real bug where salvage's path discovery is unreliable, add an `ENOENT → []` fallback then, not now.
- **Lines that parse but aren't objects** (`JSON.parse("42")`, `JSON.parse("null")`, etc.): skipped (the `isObject` guard from `stream.ts:125-127` applies). No throw.
- **`message.content` missing or not an array**: yields zero text blocks from that line. No throw.
- **No assistant messages anywhere in the file**: returns `[]`. The salvage caller is responsible for handling an empty result — most likely by rendering a placeholder like `_(no assistant messages captured)_` in the PR body. That belongs to salvage's body builder, not here.

No `try`/`catch` wraps the function body; only the per-line `JSON.parse` is wrapped (one `try`/`catch`, mirrors `stream.ts:43-50`). That's the entire error policy.

## Testing strategy

The captured fixture is the load-bearing regression artifact. The `n=5` non-empty assertion against it (test group 1) is the explicit pin against PR #138's failure mode — the test that, had it existed when v1 shipped, would have caught the silent-empty bug.

Structural assertions (chronological order, filter posture, malformed-line tolerance, `n` clamping) run against synthetic inputs to keep the assertion narrow and the failure message diagnostic. The split is the same shape `stream.test.ts` uses: fixture-driven assertions for the "field-shape contract with the SDK," synthetic-input assertions for the parser's algorithmic behaviour.

CI gate: `pnpm typecheck && pnpm test && pnpm lint` (already wired up by #1).

## Open questions

1. **Fixture file size.** The recommended capture procedure picks a real session file verbatim. If the chosen file is large (a few MB), it's checked in as test data and bloats the repo permanently. The mitigation in § "Fixture capture" is to prefer a bounded dispatcher-agent run (≤50 turns of context). If even those are >1 MB after a recent surge, the implementer may pick the smallest qualifying session (still ≥ 5 assistant text blocks) — that's a judgment call within the verbatim-capture rule, not a deviation from it.

2. **Per-message return shape.** Spec returns `string[]` (flat). The alternative — a struct array including `{role, timestamp, parentUuid}` — was considered and rejected because (a) the only known consumer (salvage's PR-body builder) wants prose to quote, (b) salvage can grep timestamps from its own dispatch logs if it ever needs them, (c) widening the return shape now commits to a contract the consumer hasn't asked for. If a real future surface needs timestamps, add a `extractLastMessagesWithMeta` sibling export rather than widening this one.

3. **Whether to filter `thinking` blocks.** The session JSONL `"assistant"` envelopes can contain `{type:"thinking", thinking:string}` blocks. The spec excludes them (the loop takes only `block.type === "text"`). Rationale: thinking blocks are the agent's internal monologue; quoting them into a triage PR conflates "what the agent told the human" with "what the agent considered." The salvage PR's `**Last messages from the agent:**` framing implies the user-facing assistant output. If a future debug surface wants thinking blocks, add a separate field — same shape rule as #9's "tool_use blocks" exclusion.

## Out of scope (explicit non-goals)

- Wiring `extractLastMessages` into `src/salvage/`. That module doesn't exist yet; its ticket will import from this file.
- Discovering which session file corresponds to a given dispatch run (encoded-cwd directory traversal, session-id mapping). That's salvage's discovery layer, not this parser's input. This function takes a fully-resolved path.
- Streaming / incremental parse. Session files are bounded by Claude's per-run context and small in practice (per ticket Technical Notes).
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" explicitly forbids barrel re-exports inside `src/`.
- Lifting `extractAssistantText` to a shared module. See Design § Reuse for the deferral rationale.
- Returning rich per-message metadata (timestamps, parentUuid, sessionId). See Open Question 2 — add a sibling export if a real future surface demands it.
- Catching `ENOENT` / permission errors and returning `[]`. See Error handling — defer until an observed failure justifies the defense.
