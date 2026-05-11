# Spec: `src/claude/stream.ts` — pure parser for Claude CLI's `stream-json` output (#9)

## Files to read first

- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — sets the file-size ceiling repeated in this ticket's AC
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — explains why this file lives in `src/claude/` even though the function itself is pure (placement follows directory semantics: it consumes a Claude-specific I/O format, so it belongs alongside the future I/O-edge code in `src/claude/`)
- `CLAUDE.md` § "Don't" — bullets "Don't write a defense for a failure mode that hasn't been observed" (constrains the malformed-line policy) and "Don't import from a barrel file" (no `src/index.ts` re-export)
- `CLAUDE.md` § "Belt-and-suspenders" — this parser is the deterministic substrate that downstream salvage / telemetry code reads; parser bugs found in production must become fixtures + assertions per the ticket body
- `CLAUDE.md` § "Test-first" — RED → GREEN → REFACTOR is mandatory
- `src/pipeline/blockers.ts:1-65` — pattern this file mirrors (top-of-file comment, `export interface`/`export type` for inputs, `export function` for predicates, internal helpers stay unexported)
- `test/pipeline/blockers.test.ts:1-105` — vitest import pattern, `.ts` extension preserved on relative imports, one `describe` per export, one `it` per assertion row
- `test/config/env.test.ts:1-15` — fixture-loading pattern (`join(__dirname, "fixtures", ...)`); this ticket reuses the same shape under `test/fixtures/claude-stream/`
- `biome.json:5-19` — formatter rules (double quotes, trailing commas all, semicolons always, 100-col line width)
- `package.json:11-18` — CI gate commands the AC implicitly invokes (`pnpm typecheck && pnpm test && pnpm lint`)
- v1 dispatcher's stream handling for prior art on field names: `agent-dispatcher/src/dispatch.ts:190-223` (`logStreamMessage` switch on `msg.type`) and `agent-dispatcher/src/dispatch.ts:312-323` (the `result` message field map: `r.result`, `r.session_id`, `r.is_error`, `r.num_turns`, `r.total_cost_usd`, `r.subtype`, `r.terminal_reason`)

## Context

This is the first `src/claude/` file. It defines the dispatcher's contract with Claude CLI's `stream-json` output: one JSON object per line over the lifetime of a `claude -p --output-format stream-json` run. Five extractions are needed downstream (per the ticket body):

- **Total cost** — for run accounting / telemetry
- **`sessionId`** — required to call `claude --resume <id>` in salvage
- **Last assistant message** — surfaced in salvage / status
- **Last N assistant messages** — quoted into the salvage PR body
- **Exit reason** — `success` / `max_turns` / `rate_limit` / `error` to drive routing (retry, escalate, mark blocked, give up)

Why a pure function rather than a streaming parser: this module has no consumers yet (per the ticket's technical note). When `src/loop/` lands, it will spawn the CLI, accumulate stdout, and call `parseStream` on the buffered string at process-close time. That keeps the parser trivially testable (string → struct) and frees the I/O layer to manage subprocess lifecycle without a parser callback shape leaking into it. If a future ticket needs incremental parsing (e.g. for live dashboards), it can wrap a streaming layer around this same set of message-shape definitions; today's no-consumer state means YAGNI applies.

The parser must not throw on malformed lines. The upstream writer (Claude CLI piped through Node's child process) can be killed mid-line when the dispatcher's timeout fires; the resulting buffer ends with a partial JSON object. Skipping malformed lines (logging them is the I/O caller's job, not the parser's) is exactly the v1 behaviour at `dispatch.ts:284-292` and `dispatch.ts:303-310`. Re-establishing it here is the pure-function version of that contract.

## Design

### File: `src/claude/stream.ts`

Single new file. One exported function (`parseStream`), three exported types (`StreamParseResult`, `ExitReason`, `ParseStreamOpts`). Estimated 130–160 production lines; under the 200-line hardcap.

#### Public types

```ts
// Discriminant for downstream routing. Closed set per AC: any future Claude
// SDK exit shape we encounter must map onto one of these four — widening the
// set is a code change, not a runtime fall-through.
export type ExitReason = "success" | "max_turns" | "rate_limit" | "error";

export interface ParseStreamOpts {
  // Number of recent text-only assistant messages to retain. Default 5 —
  // empirically enough context for a salvage PR body without producing a
  // wall of text. Callers (e.g. salvage) override per surface.
  readonly lastN?: number;
}

export interface StreamParseResult {
  // From the "result" message's `total_cost_usd`. 0 if no result message
  // was seen (the run died before the final summary line was emitted).
  readonly totalCostUsd: number;

  // From the "system" init message's `session_id` (also present on the
  // "result" message; we take the first one we see). undefined only if
  // the stream ended before any message carrying a session id.
  readonly sessionId: string | undefined;

  // The most recent text-only assistant message (the last entry of
  // `lastNAssistantMessages`, or undefined if that array is empty).
  // Convenience accessor — same data, single-string shape for the common
  // "show me the last thing the agent said" callsite.
  readonly lastAssistantMessage: string | undefined;

  // Most recent text-only assistant messages, in chronological order
  // (oldest first), capped at `opts.lastN`. Empty if no text blocks
  // appeared. tool_use / tool_result blocks are excluded — see Design § 3.
  readonly lastNAssistantMessages: readonly string[];

  // Closed-enum routing discriminant. See `mapExitReason` below for the
  // raw → enum mapping.
  readonly exitReason: ExitReason;
}
```

These are local to `stream.ts`. Per CLAUDE.md, no `src/index.ts` re-export. Future callers (`src/loop/`, `src/salvage/`) import directly from `./claude/stream.ts`.

#### Entry point

```ts
const DEFAULT_LAST_N = 5;

export function parseStream(raw: string, opts?: ParseStreamOpts): StreamParseResult {
  const lastN = opts?.lastN ?? DEFAULT_LAST_N;
  // ...iterate, accumulate, return
}
```

Pure: no `await`, no `gh` / `git` / `fs` / `process.env` reads, no shared state. The whole stream is a string passed in by the caller; the result is a frozen-readonly struct.

#### Parse loop

1. Split `raw` on `/\r?\n/`.
2. For each line: if `line.trim() === ""`, skip. Else `JSON.parse` inside a `try`; on `SyntaxError`, skip the line (do **not** throw — see Context).
3. Dispatch on `msg.type`:
   - `"system"` (when `subtype === "init"`): if `sessionId` is still undefined, capture `msg.session_id`. Ignore other system messages.
   - `"assistant"`: walk `msg.message.content` array; for each block where `block.type === "text"` and `block.text` is a non-empty string, append `block.text` to a running `assistantTexts: string[]`. Tool-use blocks are explicitly excluded.
   - `"result"`: capture the message into `resultMsg` (last one wins; the CLI emits at most one).
   - any other `type`: ignore.
4. After the loop: derive
   - `totalCostUsd`: `resultMsg?.total_cost_usd ?? 0`
   - `sessionId`: `seenSessionId ?? resultMsg?.session_id ?? undefined`
   - `lastNAssistantMessages`: `Object.freeze(assistantTexts.slice(-lastN))`
   - `lastAssistantMessage`: last entry of the slice, or `undefined`
   - `exitReason`: `mapExitReason(resultMsg)`
5. Return frozen struct.

#### `mapExitReason(resultMsg): ExitReason`

```ts
function mapExitReason(resultMsg: ResultMsgShape | null): ExitReason {
  if (!resultMsg) return "error"; // stream killed before completion
  const subtype = typeof resultMsg.subtype === "string" ? resultMsg.subtype : "";
  const terminalReason =
    typeof resultMsg.terminal_reason === "string" ? resultMsg.terminal_reason : "";

  if (subtype === "success") return "success";
  if (subtype === "error_max_turns" || terminalReason === "max_turns") return "max_turns";
  if (
    subtype === "error_rate_limit" ||
    terminalReason === "rate_limit" ||
    /rate.?limit/i.test(extractResultText(resultMsg))
  ) {
    return "rate_limit";
  }
  return "error";
}
```

Both `subtype` and `terminal_reason` are checked because v1's dispatcher reads both (`agent-dispatcher/src/dispatch.ts:215, 322`); they don't always carry the same value across SDK versions. The text-substring fallback for `rate_limit` is the conservative move: if a future SDK adds a new subtype we haven't enumerated, but the user-facing error text still says "rate limit", routing should still send the run down the rate-limit branch rather than the generic-error branch (which has retry semantics — wrong move for rate_limit).

The fallback regex is the **only** stochastic edge in this otherwise data-driven function. It's load-bearing because rate_limit is the one exit reason where the routing decision (back off + retry later) materially differs from `error` (escalate to human). Adding a fixture for the rate_limit branch (per AC) is what pins this regex against regressions.

#### Internal helpers (unexported)

- `extractAssistantText(msg): string[]` — narrow `msg.message.content` to the array of `{type:"text", text:string}` block texts.
- `extractResultText(resultMsg): string` — pull `resultMsg.result` if it's a string, else `""`.
- Inline `ResultMsgShape` / `AssistantMsgShape` interfaces with the few fields the parser reads (`{type, subtype?, session_id?, total_cost_usd?, terminal_reason?, result?, message?}`). These mirror the `Blocker` narrow-types pattern from #6.

Per the #6 precedent, helpers stay unexported until a second consumer appears. None do here — the parser is closed over its own message-shape narrowing.

### File: `test/claude/stream.test.ts`

Mirrors the source path. Vitest, RED-first.

Fixtures live at `test/fixtures/claude-stream/<exit-reason>.jsonl` — one file per exit-reason branch. Each fixture is the raw stdout of a real (or as-real-as-reproducible) `claude -p --output-format stream-json` run, captured verbatim. See § "Fixture capture" below for the operational details.

Test groups:

1. **`success` fixture**
   - Asserts `exitReason === "success"`.
   - Asserts `sessionId` is a non-empty string (and matches the `session_id` literal in the fixture's init line).
   - Asserts `totalCostUsd > 0`.
   - Asserts `lastAssistantMessage` is non-empty.
   - Asserts `lastNAssistantMessages.length` is between 1 and 5 inclusive (depends on what the recorded run said; fixture-author pins exact length).
   - Asserts `lastNAssistantMessages[lastNAssistantMessages.length - 1] === lastAssistantMessage`.

2. **`max_turns` fixture**
   - Asserts `exitReason === "max_turns"`.
   - Asserts `sessionId` is captured (max_turns runs do reach the init message).
   - Asserts `totalCostUsd > 0`.
   - Asserts `lastAssistantMessage` is captured (the agent emitted text before hitting the wall).

3. **`rate_limit` fixture**
   - Asserts `exitReason === "rate_limit"`.
   - Asserts `sessionId` is captured.
   - Asserts at least one of: `subtype === "error_rate_limit"`, or `terminal_reason === "rate_limit"`, or the `result` text matches `/rate.?limit/i`. (Whichever signal the captured fixture exposes — the test asserts the parser routed correctly given that signal.)

4. **`error` fixture**
   - Asserts `exitReason === "error"`.
   - For a fixture that includes a result message with an unrecognized subtype: the parser must route to `error`, not throw.

5. **Edge cases (no fixture file required; inline string literals)**
   - Empty input (`""`) → `exitReason === "error"`, `sessionId === undefined`, `totalCostUsd === 0`, `lastNAssistantMessages` is empty.
   - Single malformed line → same as empty.
   - Trailing partial JSON (e.g. `'{"type":"system","subtype":"init","session_id":"abc"}\n{"type":"resul'`) → init still parsed (`sessionId === "abc"`); partial line skipped; `exitReason === "error"` (no complete result message).
   - `lastN` parameter respected: stream with 7 text messages, `lastN: 3` → result has length 3, oldest of the three first.

6. **`lastN` chronological ordering** (use the `success` fixture or a synthetic one)
   - Assert `lastNAssistantMessages` is strictly oldest-first by re-ordering against the fixture's source messages.

Each `describe` block mirrors one AC bullet ("each extraction asserted against at least one fixture"). One assertion per row; no shared fixtures between describes (except by file).

### Fixture capture

Each fixture is captured by piping a real `claude -p --output-format stream-json` invocation to a file. Recommended commands:

- **`success.jsonl`**:
  ```
  claude -p --output-format stream-json -p "say hi" --max-turns 2 > test/fixtures/claude-stream/success.jsonl
  ```
- **`max_turns.jsonl`**:
  ```
  claude -p --output-format stream-json -p "explain quantum chromodynamics in 50 turns" --max-turns 1 > test/fixtures/claude-stream/max_turns.jsonl
  ```
  (force the wall-hit by setting `--max-turns 1` on a prompt that needs at least one tool call)
- **`rate_limit.jsonl`**: hard to reproduce on demand. Two acceptable sources:
  1. Pull a captured stream from the v1 dispatcher's logs the next time a real rate-limit fires.
  2. If no real capture is available before this ticket lands, synthesize a minimal fixture by **trimming** a real `success` capture down to the system-init line plus a single result line whose `subtype` is `"error_rate_limit"`. Document the synthesis at the top of the fixture file with a `// SYNTHESIZED FIXTURE` comment line preceding the JSONL — the parser's malformed-line skipping handles the comment, and a future reader can identify the fixture as not-fully-captured. The ticket body's "do not hand-edit JSON lines" rule is observed: lines from the real capture are unchanged; the synthesis is by deletion + a non-JSON marker, not by editing JSON.
- **`error.jsonl`**: trim a real capture to a result line with an unrecognized `subtype` (e.g. `"error_during_execution"`) — same synthesis rule as above. This pins the parser's "anything unmapped → error" branch.

The synthesis policy for `rate_limit` and `error` is the explicit Open Question 1 below — flag any objection before implementing.

### Implementation order (RED → GREEN, per AC)

1. `mkdir -p src/claude test/claude test/fixtures/claude-stream`.
2. Capture / synthesize the four fixtures into `test/fixtures/claude-stream/`. Inspect each by hand to confirm the message shapes are what the parser expects (especially `subtype` / `terminal_reason` / `session_id` / `total_cost_usd` field names).
3. Write `test/claude/stream.test.ts` with all assertions. Run `pnpm test` → fails (file does not exist). RED.
4. Write `src/claude/stream.ts`. Run `pnpm test` → passes. GREEN.
5. Run `pnpm typecheck && pnpm lint` → both pass.
6. Commit spec + source + tests + fixtures together (single commit, single feature).

If step 4 reveals a real fixture's field names disagree with the design (e.g. SDK has renamed `total_cost_usd` to `cost_usd`), update both the design comment and the parser to match the captured reality. The **fixture is the source of truth**, not the design — design is sketch, fixtures are verified contract.

### Files touched

- `src/claude/stream.ts` — new, ~130–160 lines
- `test/claude/stream.test.ts` — new, ~120–160 lines (one `it` per assertion row)
- `test/fixtures/claude-stream/success.jsonl` — captured data
- `test/fixtures/claude-stream/max_turns.jsonl` — captured data
- `test/fixtures/claude-stream/rate_limit.jsonl` — captured + minimally synthesized data (see § Fixture capture)
- `test/fixtures/claude-stream/error.jsonl` — synthesized data

No edits to existing files. No `src/index.ts` re-export. The four data files are inert captures (`Write` once, never edit) — they don't enlarge the design surface.

The developer should also append the standard per-ticket implementation summary at `docs/knowledge/codebase/9.md` (matching the `1.md` / `6.md` precedent) and add a `### Stream-json parsing (#9)` section to `docs/PROJECT-MEMORY.md` under "Patterns established", recording the message-shape fields the parser depends on (so future SDK upgrades have a single place to grep). These are docs touchups, not code, and stay in the dev's normal post-implementation pass.

## Concurrency model

None. Pure synchronous function over a string. The whole point of pushing this into a pure shape is that there's nothing to coordinate.

## Error handling

- **Malformed JSON lines**: skipped silently (the I/O caller logs raw lines if it cares; the parser's job is to extract whatever signal is recoverable). Documented in the top-of-file comment.
- **Missing fields on a present message**: treated as "field absent" — `total_cost_usd === 0`, `session_id === undefined`, etc. The result struct's contract is "best effort"; the caller decides whether undefined fields warrant retrying or escalating.
- **No result message at all**: `exitReason === "error"`, `totalCostUsd === 0`. This is the dispatcher-killed-mid-stream case (timeout fired, partial buffer).
- **No throws**: the function cannot throw on any string input. The caller has no try/catch obligation.

No fallbacks, no defensive `?? []`, no try/catch wrapping the whole loop. The line-level try/catch is the only one, and it discards the line — that's the entire error policy.

## Testing strategy

The four real-shape fixtures are the load-bearing surface. They pin the parser to actual SDK output, so the next time the SDK changes a field name, exactly one fixture mismatch will surface in CI rather than a silent runtime drift.

Per the ticket's "fixtures should be captured verbatim" rule, the implementer must NOT hand-edit JSON lines inside a fixture. Synthesis (for `rate_limit` / `error`) is by deletion + a non-JSON marker line only; lines that *are* JSON are taken verbatim from a real capture.

Per CLAUDE.md "Test-first": write the assertions before the parser. The temptation to write the parser first and then "make tests pass" against the parser's behaviour (rather than the fixture's documented contract) is the regression-magnet failure mode test-first prevents.

CI gate: `pnpm typecheck && pnpm test && pnpm lint` (already wired up by #1).

## Open questions

1. **Synthesis policy for `rate_limit` / `error` fixtures.** Spec recommends "trim a real capture + non-JSON marker comment line". Alternative: defer the `rate_limit` fixture to a follow-up ticket landed the first time a real rate-limit is captured in production, and ship `#9` with three fixtures (success / max_turns / error). The AC says "minimum four fixtures" so the recommendation is to synthesize. Implementer can flip to "defer" if they think the synthesis materially weakens the test contract — but then this ticket misses an AC, which is a `needs-rework` signal, not an architect override. Recommendation: synthesize; document the synthesis at the top of each affected fixture.

2. **`lastN` default of 5.** The PR-body context budget is the binding constraint. v1's salvage PRs quoted "the last assistant message" only (singular); jumping to 5 here is the architect's call as the ticket leaves it open. If 5 produces a wall of text in the first real salvage event, callers can override per-surface — `lastN` is a parameter, not a constant.

3. **Tool-use / tool-result blocks excluded from `lastNAssistantMessages`.** Spec excludes them because tool inputs are noisy and not user-readable in a PR body. If future use cases want them in (e.g. a "what was the agent doing when it died" debug surface), add a separate `toolUseSummary` field rather than widening `lastNAssistantMessages` — keep the existing field's contract narrow.

4. **`subtype` enumeration is best-effort, not exhaustive.** We map `"success"`, `"error_max_turns"`, `"error_rate_limit"` (assumed), and `terminal_reason` variants. Anything unmapped falls through to `"error"`. Compile-time exhaustiveness over a `const` union of known subtypes (with a `never`-typed `default`) was considered and rejected: the SDK can introduce new subtypes between releases, and a TS compile error in a deployed dispatcher is worse than a runtime fall-through to `"error"`. The right discipline is the fixture set: every observed new subtype gets a fixture and a test row, growing the mapping deterministically.

## Out of scope (explicit non-goals)

- Wiring `parseStream` into `src/loop/` or `src/salvage/`. Those modules don't exist yet; consumer tickets will import from this file.
- A streaming / incremental parser. Current call shape is "buffer the full stream, then parse" (matches v1). Streaming is a future ticket if a live-dashboard surface needs it.
- Field-by-field exhaustive validation of the `result` message (e.g. asserting `num_turns` is non-negative). The parser extracts the five things the AC names; everything else is the caller's problem.
- A Zod / runtime-schema dependency. The narrow inline shapes (`ResultMsgShape`, `AssistantMsgShape`) are sufficient; pulling in a schema library for a 150-line module is over-engineering.
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" bullet explicitly forbids barrel re-exports inside `src/`.
- Capturing fixtures from sources other than the Claude CLI's `--output-format stream-json` (e.g. the IDE's session JSONL files at `~/.claude/projects/<encoded-cwd>/sessions/`). Those have a different shape (queue-operation envelopes, no `result` message); using them would force the parser to handle two shapes when only one is the dispatcher's actual input. If a future ticket needs to read session JSONL, give it its own parser.
