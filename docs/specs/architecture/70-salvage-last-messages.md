# Spec: `src/salvage/last-messages.ts` — compose PR body section from session JSONL (#70)

## Files to read first

- `src/claude/jsonl.ts` (entire file, 61 lines) — the producer this module consumes. Signature is `extractLastMessages(jsonlPath: string, n: number): Promise<string[]>`; result is oldest-first assistant text strings, `[]` if none, and `readFile` rejections (e.g. `ENOENT`) **propagate** rather than being caught. The composer in this ticket is the layer that converts that propagation into the AC's "missing file → empty section, does not throw" contract.
- `docs/specs/architecture/61-claude-jsonl.md` § "Error handling" and § "Open Question 2/3" — explains *why* the extractor lets `ENOENT` propagate (path validation belongs to the discovery layer) and why `thinking` blocks are filtered upstream. Both decisions shape the composer's contract: it must own the missing-file fallback, and it can assume every string returned is already user-facing assistant text (no need to re-filter `thinking` or `tool_use`).
- `docs/knowledge/codebase/61.md` § "Patterns established" — the "captured fixture + non-empty assertion" regression posture and the wire-format-parsers-stay-separated rule. The composer adds nothing to that fixture/regression surface (it's not a parser), but it inherits the empty-section bug shape from PR #138: a test that only asserts "does not throw" is the failure mode to avoid.
- `src/salvage/gate.ts` and `test/salvage/gate.test.ts` — sibling under `src/salvage/`. Establishes the module-shape precedent: small pure-ish module, one or two exports, no orchestration. The composer follows the same shape (single exported async function, no `GateRunner`-style DI because there's only one I/O dependency and it's already minimal).
- `CLAUDE.md` § "One concern per file, hardcap 200 lines", § "Pure functions in `src/pipeline/`, I/O at the edges", § "Don't (no barrel imports)", § "Test-first" — sets the file-size ceiling, places this file under `src/salvage/` (I/O edge: it awaits `extractLastMessages`), forbids the barrel re-export, and pins RED-before-GREEN.
- `biome.json:5-19` — formatter rules (double quotes, trailing commas all, semicolons always, 100-col).

## Context

When the dispatcher salvages a `max_turns` run, it opens a draft PR for human triage. The PR body embeds the agent's last few assistant messages so the operator reading the draft can understand what the agent was working on without opening the raw JSONL transcript. The JSONL parser (`src/claude/jsonl.ts`, #61) is already in place. This ticket adds the composer that turns its `string[]` output into the Markdown section the PR body builder will splice in under a fixed `**Last messages from the agent:**` header.

This is a thin formatter — no I/O of its own beyond the `extractLastMessages` call, no parsing, no path discovery. It does own the one transformation the parser deliberately leaves to its caller: converting a missing/unreadable file into an empty-section render rather than an exception.

PR #138's regression (v1 dispatcher's `**Last messages**` shipped empty because the extractor returned the wrong shape) was fixed at the parser layer in #61. This ticket inherits the lesson but doesn't re-fight it — the composer's failure mode is different: it could in principle drop messages on the floor or render them in a way that doesn't survive Markdown escaping inside a blockquote. The tests pin both shapes.

## Design

### File: `src/salvage/last-messages.ts`

Single new file. One exported async function. No exported types. Estimated 25–40 production lines; well under the 200-line hardcap.

#### Public signature

```ts
import { extractLastMessages } from "../claude/jsonl.ts";

export async function composeLastMessagesSection(
  jsonlPath: string,
  n: number,
): Promise<string>;
```

- **Input.** `jsonlPath`: path to the session JSONL the dispatcher captured for the salvaged run. `n`: cap on how many recent assistant messages to render (the salvage orchestrator's call — likely 3 or 5 in practice; this module accepts any non-negative integer and clamps via the underlying extractor).
- **Output.** A Markdown string. Always begins with the literal line `**Last messages from the agent:**`. Followed by a blank line and either the rendered turns or the empty-section placeholder. No trailing newline — the caller splices this into a larger body and owns the surrounding whitespace.
- **Async.** Returns `Promise<string>` because the underlying extractor is async. Never rejects (see § Error handling).

No options struct, no return-object struct, no `formatOpts`. If a future surface needs a different rendering (e.g. plain text for a Slack notification), add a sibling export rather than parameterising this one — same shape rule as #61.

#### Composition steps

1. Call `extractLastMessages(jsonlPath, n)` inside a `try` block.
2. On success, render via the format below.
3. On rejection (any error — `ENOENT`, `EACCES`, `EISDIR`, whatever), render the empty-section placeholder. The composer catches **all** rejections from the extractor, not just `ENOENT`. Rationale: the AC bullet says "empty/missing file → header followed by an empty section (does not throw)" — and from this module's vantage, "missing" and "unreadable" are operationally the same: no content to quote. The salvage flow is a recovery surface; an exception thrown while building a recovery PR would itself need recovery. Suppress here, surface in logs at the dispatcher level if salvage wants to.

#### Markdown format (architect's call per Technical Notes)

Header (always present, literal, no trailing space):

```
**Last messages from the agent:**
```

Then a blank line, then either:

**Empty case** — file missing, file empty, file has no assistant text blocks, or the extractor returned `[]` for any reason:

```
_(no assistant messages captured)_
```

**Non-empty case** — one or more strings returned from the extractor. Each string is rendered as a GitHub blockquote (every line prefixed with `> `, blank lines within a message rendered as a bare `>`). Turns are separated by a horizontal rule on its own line, with blank lines around it:

```
> message 1, line 1
> message 1, line 2
>
> message 1, line 4 (after a blank line within the message)

---

> message 2, line 1
```

Why blockquote-with-rule:

- The agent's output is prose-shaped (often containing its own Markdown — code fences, lists, headers). A bare paragraph would let the agent's content collide with the PR body's structure; a blockquote scopes it visually and prevents an agent-emitted `## heading` from breaking the PR body's outline.
- Adjacent blockquotes in GitHub Markdown merge into one visual block. A horizontal rule between turns is the cheapest way to make turn boundaries legible to the operator scanning the PR.
- No fence (no triple-backtick block) because the agent's text frequently *contains* fenced code blocks, and nesting fences in Markdown is brittle. Blockquotes don't have that problem.

Escaping: none. The extractor returns the agent's raw text. If the text contains a line that starts with `> `, the rendered blockquote will have `> > ...` — a nested quote, which is correct semantically. If the text contains `---` on its own line, it appears as `> ---` inside the quote (still a blockquote line, not a horizontal rule, because the `> ` prefix wins). No regex-based escaping is needed and none should be added — escaping risks corrupting agent-emitted Markdown and creates a maintenance surface for a problem we haven't observed.

The renderer is one helper function:

```ts
function renderTurn(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}
```

And the join:

```ts
const body = turns.map(renderTurn).join("\n\n---\n\n");
```

Full assembly: `${HEADER}\n\n${body || PLACEHOLDER}`.

#### Behavioural matrix (AC-anchored)

| Input shape | Output (after the header + blank line) |
|---|---|
| File with ≥ N assistant text blocks | Last N rendered as blockquoted turns, separated by `---` |
| File with M < N assistant text blocks | All M rendered as blockquoted turns, separated by `---` |
| File with zero assistant text blocks (only `user` / `queue-operation` lines) | `_(no assistant messages captured)_` |
| Empty file (0 bytes) | `_(no assistant messages captured)_` |
| Missing file (`ENOENT` from `readFile`) | `_(no assistant messages captured)_`, no throw |
| `n === 0` | `_(no assistant messages captured)_` (extractor returns `[]`, composer renders placeholder) |

### File: `test/salvage/last-messages.test.ts`

Mirrors the source path. Vitest, RED-first. ~80–110 lines.

The composer's algorithm has no fixture dependency — the parser (`extractLastMessages`) already owns the fixture-driven regression pin against PR #138. The composer's tests use synthetic JSONL via the same `mkdtempSync` + `writeFileSync` pattern as `test/claude/jsonl.test.ts:1-32` (lift `assistantLine` / `textAssistantLine` / `writeTmpFile` helpers verbatim — small enough that copying beats sharing; same precedent as `extractAssistantText`'s duplication across `stream.ts` and `jsonl.ts`).

Test groups (one `describe` per group, one `it` per assertion row):

1. **Header is always present** (AC bullet 2 — literal header):
   - For a non-empty file: result starts with `**Last messages from the agent:**\n\n` (header, blank line, then content).
   - For an empty file: same.
   - For a missing path (a tmp path that was never written): same.

2. **≥ N messages → last N rendered** (AC bullet 4):
   - 5-message synthetic JSONL (`"a"`, `"b"`, `"c"`, `"d"`, `"e"`), `n=3` → result body equals exactly:
     ```
     > c

     ---

     > d

     ---

     > e
     ```
   - Pinned via `toBe` against the full assembled string (not a substring check) — locks the chronological order, the separator shape, and the blockquote prefix in one assertion.

3. **< N messages → all rendered** (AC bullet 4):
   - 2-message synthetic JSONL (`"first"`, `"second"`), `n=10` → result body equals exactly:
     ```
     > first

     ---

     > second
     ```
   - Length-3 messages, `n=10`, asserts equality against the full expected string (header + body).

4. **Empty / missing file → placeholder** (AC bullet 4 — does not throw):
   - Empty file (0 bytes) → result equals `**Last messages from the agent:**\n\n_(no assistant messages captured)_`. `expect(...).resolves` form, asserts no throw via the matcher.
   - Missing path (`/nonexistent/path.jsonl` or a tmp path the test never creates) → same result. No throw.
   - File with only `queue-operation` and `user` lines (no assistant envelopes) → same placeholder. This is the "extractor returns `[]`" path; verified separately from the missing-file path so the suppression and the empty-array-render are both pinned.

5. **Multi-line agent turn renders as a multi-line blockquote** (locks the per-line `> ` prefix):
   - One assistant line whose text is `"line one\nline two\n\nparagraph two"` (note the blank line inside the turn). Result body equals exactly:
     ```
     > line one
     > line two
     >
     > paragraph two
     ```
   - Pins the bare-`>` rendering of an empty line within a turn (the algorithmic detail in `renderTurn`).

6. **No escaping — agent-emitted Markdown survives verbatim inside the blockquote** (pins the deliberate non-escaping decision):
   - Assistant text `"```ts\nconst x = 1;\n```"` → blockquote with each of those four lines prefixed by `> `. The fence lines render as `> \`\`\`ts` and `> \`\`\`` — GitHub renders these as preserved fence syntax inside a quote, which is the intended behaviour.
   - Assistant text containing `"---"` on its own line → renders as `> ---` (a quoted dash-rule line, not a parsed horizontal rule). Asserts the literal output, not the rendered DOM.

7. **`n === 0` → placeholder** (clamp behaviour propagates from `extractLastMessages`):
   - 3-message synthetic JSONL, `n=0` → result equals header + placeholder. The composer doesn't special-case `n === 0`; it inherits the extractor's clamp and renders the empty-result branch.

Test 4's missing-file case is the load-bearing assertion for the AC's "does not throw" contract. Test 2's exact-string `toBe` is the load-bearing assertion for the formatting contract — a future refactor that "improves" the separator or moves the blank-line policy will break it loudly.

### Implementation order (RED → GREEN, per CLAUDE.md § Test-first)

1. Write `test/salvage/last-messages.test.ts` with all seven assertion groups. Lift `assistantLine`, `textAssistantLine`, `writeTmpFile` from `test/claude/jsonl.test.ts` (copy, don't share — two consumers don't yet justify a shared test helper).
2. Run `pnpm test` → fails (source file does not exist). RED.
3. Write `src/salvage/last-messages.ts`. Run `pnpm test` → passes. GREEN.
4. Run `pnpm typecheck && pnpm lint` → both pass.
5. Commit spec + source + tests together.

### Files touched

- `src/salvage/last-messages.ts` — new, ~25–40 lines
- `test/salvage/last-messages.test.ts` — new, ~80–110 lines (test files don't pay the production cap)

No edits to existing files. No `src/index.ts` re-export.

## Concurrency model

None. One `await extractLastMessages(...)` (which itself is one `await readFile(...)` + synchronous iteration) wrapped in a `try`/`catch`, then synchronous string assembly. The function is reentrant — no module-level state. Two concurrent calls on different paths produce two independent results.

## Error handling

- **`extractLastMessages` rejects** (file missing, permission denied, I/O error, any other Node `readFile` failure): caught and converted to the empty-section render. The composer never rethrows.
- **`extractLastMessages` resolves with `[]`**: rendered as the empty-section placeholder. Same branch as the rejection path — both flow into `body || PLACEHOLDER`.
- **`extractLastMessages` resolves with non-empty `string[]`**: each string rendered via `renderTurn`, joined with `\n\n---\n\n`. No filtering, no truncation, no length cap. The extractor already filters `tool_use` and `thinking` (per #61); the composer trusts its output.

No logging. The composer is a pure-ish formatter — if the salvage orchestrator wants to log "session file was missing," that decision belongs at the orchestrator, where the path was resolved and the broader recovery context is available. Logging inside the composer would either double-log (orchestrator also logs) or surface noise during tests.

### Why "catch all rejections" rather than "catch only `ENOENT`"

The AC says *"empty/missing file → header followed by an empty section (does not throw)"*. A literal reading covers only the missing-file case, which would suggest catching `ENOENT` specifically and letting `EACCES` / `EISDIR` / etc. propagate.

The looser interpretation — catch everything — is preferable here:

1. From the operator's vantage when reading the PR, "section is empty because we couldn't read the file" and "section is empty because the file was empty" are indistinguishable and equivalent. The dispatcher logs are the place to differentiate.
2. The salvage flow is itself a recovery surface. An exception thrown while building a recovery PR escalates a `max_turns` event into a dispatcher crash. The composer's failure-mode budget is "render placeholder," not "rethrow."
3. CLAUDE.md "Don't write a defense for a failure mode that hasn't been observed" cuts the other way too — we haven't observed an `EACCES` either, but the cost of the broader catch is one extra branch saved (no error-code discrimination), and the alternative shipping is a flaky failure mode where occasional permission errors crash the dispatcher.

If a future ticket shows a real reason to surface specific failure codes (e.g. monitoring needs to count `ENOENT` vs `EACCES` separately), thread an `onError` callback through then — not now.

## Testing strategy

Synthetic JSONL via `mkdtempSync` + `writeFileSync` for every test. No captured fixture — the captured-session fixture is the parser's regression contract (#61), not the composer's. The composer's contract is "given a `string[]` from the extractor, produce a Markdown string of this exact shape," and that's best pinned by exact-string equality against authored inputs.

The load-bearing assertions:

- **Test group 2's full-string `toBe`** locks the format contract. A future "clean up the rendering" PR will break this loudly rather than silently shifting the section's shape.
- **Test group 4's missing-file case** locks the "does not throw" AC bullet. Without it, a future refactor could narrow the `try`/`catch` to `ENOENT`-only and silently regress the broader recovery posture.

CI gate: `pnpm typecheck && pnpm test && pnpm lint` (wired by #1).

## Open questions

1. **Placeholder text wording.** The spec uses `_(no assistant messages captured)_`. Italic emphasis (`_..._`) is GitHub-Markdown-rendered as `<em>`, which reads as "this is a parenthetical state note, not absent content." Alternatives considered: bare `_(none)_`, or omitting the placeholder entirely and ending the section with just the header + blank line. The italic phrasing is the most operator-friendly when scanning a triage PR — the human knows immediately that "no messages" was a deliberate render, not a build error. If the salvage orchestrator's stakeholders prefer different wording, change the constant; the format contract is otherwise stable.

2. **Truncation per-turn.** Agent messages can be long (thousands of characters). The composer does no length-capping. The salvage caller picks `n` (count of turns) but has no `maxChars` knob. If reviewers find PRs hard to scan because turns are too long, add a per-turn ellipsis truncation at that point — same evidence-based-fix posture as everywhere else. Don't preempt it.

3. **Whether to expose `renderTurn` for reuse.** Kept private. If a second surface needs to render a single agent turn (e.g. a notification body), extract then. Two consumers don't yet exist — premature.

## Out of scope (explicit non-goals)

- Wiring `composeLastMessagesSection` into the salvage PR body builder. That builder doesn't exist yet; its ticket will import from this file. (Same posture as #61's "wiring into `src/salvage/`" out-of-scope bullet.)
- Discovering which session JSONL corresponds to a given salvaged dispatch run (encoded-cwd traversal, session-id mapping). Salvage's discovery layer.
- Length-capping per-turn output. See Open Question 2.
- Filtering `thinking` or `tool_use` blocks. Already handled upstream in `extractLastMessages`. The composer trusts its input.
- Logging when the file is missing. Belongs at the orchestrator. See § Error handling.
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" forbids barrel re-exports inside `src/`.
- Parameterising the Markdown shape (alternate separators, plain-text mode). See Open Question 3 — add a sibling export if a real surface demands a different rendering.
