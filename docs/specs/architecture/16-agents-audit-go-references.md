# Spec #16 — Audit + adapt Go-specific references in ported agent CLAUDE.md

## Files to read first

The target files live in the sibling repo `pyrycode/agent-dispatcher-v2-agents`, **not in this repo**. Clone it once, then read these (paths relative to that repo's root):

- `po/CLAUDE.md` (221 lines) — only 2 Go hits, both `main.go` filename examples in cross-package signals around lines 102 + 114
- `architect/CLAUDE.md` (248 lines) — heaviest file; Go hits in the file-overlap-check example block (~140), Files-to-read-first example (~190–193), "Stay within Go idioms" (~234), and the entire "## Go Architecture Patterns" section (~243–247)
- `architect/security-review.md` (117 lines) — Go crypto primitives section (~51, 62), example findings citing `internal/control/handler.go` and `http.Server` (~107, 109)
- `developer/CLAUDE.md` (171 lines) — title "implement Go features" (line 4); commands block ~93–95 and ~167–170; worked examples #128 and #155 (~151, 153) reference goroutine leak + data race
- `code-review/CLAUDE.md` (152 lines) — title "Go idiom compliance" (line 4); the entire "### Go-Specific" subsection ~60–66; `go.mod` mention ~73; commands ~106; example output `file.go:42` ~126–128
- `documentation/CLAUDE.md` (78 lines) — **already clean** of Go references. Re-grep at the end to confirm, but no edits expected.

Also in this repo (for TS-tooling anchors):

- `package.json` — `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format` (biome). These are the substitution targets.

## Context

The 5 agent CLAUDE.md files in `pyrycode/agent-dispatcher-v2-agents` are direct ports from the v1 `pyrycode/agents` repo. The lessons they encode (sizing, anti-rationalization, file-overlap, salvage flow, predicate-completeness) are the reason they were ported and must survive intact. The Go-flavoured *toolchain examples* in those lessons (`go test -race`, `gofmt`, "the Go daemon", goroutine-leak worked examples) no longer apply — the v2 dispatcher is a TypeScript/Node project under Biome + Vitest + tsc.

This is an audit-and-adapt pass, not a redesign. Lessons stay; tooling flips.

**Pyrycode branding is OUT OF SCOPE.** Pyrycode #N incident references (e.g. "Pyrycode #29 burned its 50-turn budget…") ARE the lessons and must stay verbatim. `mcp__qmd__query(collection: "pyrycode-docs", …)` lines, `gh --repo pyrycode/pyrycode`, "Pyrycode" agent titles — left as-is for a separate ticket. Touching them in this PR widens the diff beyond what the AC asks for.

## Design

### Substitution table

This is the authoritative mapping. Apply mechanically, then re-read each edit in context to make sure the surrounding sentence still flows.

| Go reference | Replacement |
|---|---|
| `go test ./...`, `go test -race ./...` | `pnpm test` |
| `go test -race -v ./internal/...` | `pnpm test -- <path-or-pattern>` (vitest's filter form) |
| `go vet ./...` | `pnpm typecheck` |
| `go build ./cmd/pyry`, `go build -o pyry ./cmd/pyry` | `pnpm typecheck` (v2 has no analogous binary build; `pnpm start` runs the dispatcher via tsx) |
| `gofmt` | `pnpm lint && pnpm format` (Biome — non-negotiable, same spirit) |
| `go.mod` | `package.json` |
| `.go` file extensions in example paths | `.ts` |
| `cmd/pyry/main.go` (entry point in examples) | `src/dispatch-bin.ts` (the actual v2 entry, per `package.json` `"start"`) |
| `internal/sessions/pool.go`, `internal/e2e/harness.go`, etc. (illustrative paths in architect's "Files to read first" example) | Pick representative v2 paths: `src/pipeline/transitions.ts`, `src/github/issues.ts`, `src/loop/dispatch.ts`. These appear in a *worked example block* — they don't need to be real files, just plausible TS analogues. |
| `internal/control/handler.go`, `http.Server` (security-review example findings) | `src/github/client.ts`, `undici` / `node:http` request client — keep the example illustrative; don't invent v2-specific security findings |
| "goroutines coordinated via context + channels, `errgroup` for fan-out" | "async functions coordinated via `AbortSignal` + Promises, `Promise.all` / `Promise.allSettled` for fan-out" |
| "the Go daemon" / "the daemon" (when meaning the dispatcher) | "the v2 dispatcher" |
| "implement Go features" (developer title) | "implement TypeScript features" |
| "Go idiom compliance" (code-review title) | "TypeScript idiom compliance" |
| "### Go-Specific" subsection header (code-review) | "### TypeScript-Specific" |
| "Stay within Go idioms" (architect constraint) | "Stay within TypeScript idioms" |
| "## Go Architecture Patterns" (architect, ~lines 243–247) | "## TypeScript Architecture Patterns" — rewrite bullets to: module-level design (one concern per file, ≤200 lines per this repo's CLAUDE.md), small interfaces defined at the consumer, async coordination via `AbortSignal` + Promises, dependency injection via constructor arguments. Match the spirit of the originals, not the letter. |
| Race-condition checks in code-review ("`go test -race` should pass", `staticcheck`) | Reframe as TS equivalents: shared mutable state guarded, `pnpm typecheck` clean, Biome clean. Drop the `staticcheck` line — Biome covers it. |
| `crypto/tls`, `golang.org/x/crypto/argon2`, `tls.VersionTLS12` (security-review § Cryptography) | `node:crypto` / `node:tls`; for password hashing reach for `argon2` (npm) or `node:crypto.scrypt`; TLS min version via `tls.DEFAULT_MIN_VERSION` or `secureOptions`. Keep the "reject hand-rolled crypto" principle; replace the Go stdlib names with their Node analogues. |
| `error` return convention (Go idiom) | Throw `Error` (or typed subclass); use Result-style discriminated unions only if the local module already does — this repo's `src/pipeline/` uses thrown errors. |
| `file.go:42` (example output lines in code-review) | `file.ts:42` |

### Worked-example handling (developer/CLAUDE.md ~151, 153)

The `#128` example (goroutine leak in `internal/supervisor/bridge.go`) and `#155` example (data race in `session.go`) teach the *out-of-scope-bug salvage rule*. That lesson is language-agnostic: "found a real bug outside the test you wrote → file a ticket, don't fix in-place". Keep both examples but de-Go-ify the framing:

- `#128`: replace "real `io.Copy` goroutine leak in `internal/supervisor/bridge.go`" → "real resource leak in <plausible v2 module>" or just "real leak in a supervisor module". The Go-stdlib reference is what makes it Go-flavoured; the lesson is the in-place vs out-of-scope distinction.
- `#155`: replace "pre-existing race in `session.go`" → "pre-existing concurrency bug in a sibling module". Drop `Session.Evict` / `evictedCh` / `pool.persist()` specifics — those are Pyrycode internals and don't translate. Keep the structural lesson: "the failing test exposed a bug in code outside the diff; correct move was bail + file, not fix in-place".

Per the ticket's AC #4: *"either generalized so the lesson lands without the Go framing, or removed if the lesson doesn't survive de-Go-ification."* Both examples survive generalization — the salvage lesson is the load-bearing piece.

### Pyrycode-incident references (preserve verbatim)

These are NOT Go references and must NOT change. Listed here to prevent accidental edits:

- "Pyrycode #29 (interface rename across 5 test files…)" (architect:88)
- "Pyrycode #29 and #40 both hit max_turns at 51 ($3.84 and $5.16…)" (po:108)
- "Pyrycode #45 (sized M, 5-file cross-package…)" (po:80)
- "Pyrycode #41 burned ~$4 this way…" (po:155)
- "Pyrycode #55 burned 84% of its 50-turn budget…" (architect:196)
- "Pyrycode #40 hit this exact failure" (architect:182)
- "2026-05-08 #182/#187 incident proved the same point" (architect:182)
- The "Pyrycode #75 (2026-05-03 later afternoon)" worked example (architect, mid-file)
- "KitchenClaw #72/#73; Pyrycode #29 and #40" (architect:241)
- "#128" / "#155" developer worked examples — keep ticket numbers + structural shape, only de-Go-ify the code-level details per above

The five accumulated lesson areas listed in the ticket — sizing, anti-rationalization, file-overlap, salvage flow, predicate-completeness — live across these incident references and the surrounding prose. If you find yourself rewriting a sentence whose subject is one of those five areas, stop and re-read the AC: only the Go *examples* embedded in the prose should change, not the rule the prose is teaching.

### Per-file change inventory

What you should expect to edit in each file. Counts are approximate; verify with grep.

**`po/CLAUDE.md`** (smallest delta — ~2 edits)
- ~line 102: `main.go` → `src/cli/main.ts` or similar (it's part of an illustrative "and" signal example)
- ~line 114: `cmd/pyry/main.go` in the slice-split example → equivalent TS path

**`architect/CLAUDE.md`** (largest delta — ~10 edits)
- File-overlap check shell example (~140): `FILES=("internal/sessions/pool.go" …)` → TS-flavoured paths like `src/pipeline/transitions.ts`, `test/pipeline/transitions.test.ts`, `src/dispatch-bin.ts`
- "Files to read first" worked example (~190–193): the four illustrative lines `internal/sessions/pool.go:371-415`, etc. → TS-flavoured analogues. Keep the pedagogical shape (path + line range + one-line "what to extract").
- ~234: "Stay within Go idioms" → "Stay within TypeScript idioms"
- ~243: "## Go Architecture Patterns" header → "## TypeScript Architecture Patterns"
- ~244–247: rewrite the four bullets per substitution table (module-level design, small interfaces, async coordination via AbortSignal+Promises, DI via constructors)
- Skim for `\bgo\b` false positives ("go straight to commit" ~217, "go through" ~147) — leave these alone

**`architect/security-review.md`** (~5 edits)
- ~51: TLS / hashing / KDF primitives Go-flavoured → Node-flavoured per table
- ~62: `tls.VersionTLS12` and "Go's secure defaults" → Node equivalents
- ~107, 109: example findings citing Go paths/types → TS paths. Keep the "No findings" structure; only the cited file/symbol names change.
- ~11: "go deeper, not shallower" — false positive, leave it
- ~80: `pyrycode/pyrycode/docs/protocol-mobile.md` — Pyrycode reference, OUT OF SCOPE for this ticket

**`developer/CLAUDE.md`** (~8 edits)
- Line 4: "implement Go features" → "implement TypeScript features"
- Line 15: `go test -race ./...` and `go vet ./...` in the must-pass-before-PR sentence → `pnpm test` and `pnpm typecheck`
- ~87: "`gofmt` is non-negotiable" → "Biome (`pnpm lint && pnpm format`) is non-negotiable"
- ~93–95 commands block: full replacement to `pnpm test`, `pnpm typecheck`, `pnpm typecheck` (no separate build step) with comments updated
- ~151 (`#128` worked example): de-Go-ify the bridge.go / io.Copy specifics per above
- ~153 (`#155` worked example): de-Go-ify the session.go / Session.Evict / evictedCh specifics per above
- ~167–170 second commands block: same treatment as ~93–95
- Skim ~147 "supposed to go through" — false positive, leave it

**`code-review/CLAUDE.md`** (~9 edits)
- Line 4: "Go idiom compliance" → "TypeScript idiom compliance"
- ~60: "### Go-Specific" → "### TypeScript-Specific"
- ~66: race-condition bullet, drop `go test -race` reference, reframe as "shared mutable state guarded; `pnpm test` covers concurrency cases via fake timers"
- ~73: "added to `go.mod`" → "added to `package.json`"
- ~94: "go to Severity Levels" — false positive, leave it
- ~106: `go vet, staticcheck, go test -race` → `pnpm typecheck, pnpm lint, pnpm test`
- ~126–128: example `[MUST FIX] file.go:42` lines → `file.ts:42` (three of them)

**`documentation/CLAUDE.md`**
- No expected edits. Run the grep at the end and confirm clean.

### Working in the sibling repo

The target files are NOT in this repo. The dispatcher's auto-commit safety-net commits **everything in the worktree** to `feature/16` and pushes it. Two consequences:

1. **Do NOT clone the sibling repo inside the worktree.** If you do, the entire sibling repo will be committed to this repo's `feature/16` branch. Clone to `/tmp/agent-dispatcher-v2-agents-edit` or another scratch path outside the worktree.
2. **The PR goes to `pyrycode/agent-dispatcher-v2-agents`, not this repo.** This ticket lives in `pyrycode/agent-dispatcher-v2` for tracking, but the diff lands in the agents repo. Open the PR there with `gh pr create --repo pyrycode/agent-dispatcher-v2-agents`.

Suggested workflow:

```bash
cd /tmp && rm -rf agent-dispatcher-v2-agents-edit
gh repo clone pyrycode/agent-dispatcher-v2-agents agent-dispatcher-v2-agents-edit
cd agent-dispatcher-v2-agents-edit
git checkout -b audit/16-de-go-ify

# … make edits across the 5 files per inventory above …

# Verification
grep -niE '\bgo\b|golang|go (test|vet|build|fmt)|gofmt|\.go\b|errgroup|goroutine' \
  po/CLAUDE.md architect/CLAUDE.md architect/security-review.md \
  developer/CLAUDE.md code-review/CLAUDE.md documentation/CLAUDE.md
# Acceptable remaining hits: "go ahead", "ago", "go straight", "go through",
# "go to", "go deeper" — all false positives. Anything else fails AC #1.

git add -A
git commit -m "audit: de-Go-ify ported agent CLAUDE.md files (pyrycode/agent-dispatcher-v2#16)"
git push -u origin audit/16-de-go-ify
gh pr create --repo pyrycode/agent-dispatcher-v2-agents \
  --title "audit: de-Go-ify ported agent CLAUDE.md files" \
  --body-file <(cat <<EOF
…per-file changelog per spec § "PR description template"…
EOF
)
```

Then return to the worktree and signal completion — there's nothing to commit *here* (the spec is the only artifact, and the architect already committed it). The dispatcher's empty-branch guard will see no developer-side changes and route appropriately; the actual delivery is the PR opened against the sibling repo. **Mention the sibling-repo PR URL in the GitHub issue comment** so the human reviewer can find it.

### PR description template

The AC requires per-file changelog proving this was a read-through, not a `sed` pass. Template:

```markdown
Closes pyrycode/agent-dispatcher-v2#16.

## Per-file changes

### po/CLAUDE.md
- Changed: `cmd/pyry/main.go` → <new path> in lines …, … (illustrative example paths only; lessons unchanged)
- Kept: all Pyrycode #N incident references (#29, #40, #41, #45 — these ARE the lessons per ticket AC #5)

### architect/CLAUDE.md
- Changed: file-overlap-check shell example (lines …–…) — Go filenames → TS analogues
- Changed: "Files to read first" worked example (lines …–…)
- Changed: "Stay within Go idioms" → "Stay within TypeScript idioms"
- Changed: "## Go Architecture Patterns" section header + bullets rewritten for TS (lines …–…)
- Kept: all incident references, the size-check red-line rules, the file-overlap-check logic itself

### architect/security-review.md
- Changed: cryptography section (lines …–…) — Go stdlib names → Node analogues
- Changed: example findings (lines …, …) — Go paths → TS paths
- Kept: threat-modeling categories, decision criteria, output format, the "no transitive trust" rule

### developer/CLAUDE.md
- Changed: title "Go features" → "TypeScript features"
- Changed: must-pass commands `go test -race / go vet` → `pnpm test / pnpm typecheck`
- Changed: `gofmt` non-negotiable → Biome non-negotiable
- Changed: two commands blocks (lines …–… and …–…)
- Changed: worked example #128 — generalized away from `io.Copy` / `bridge.go`; salvage lesson preserved
- Changed: worked example #155 — generalized away from `Session.Evict` / `session.go`; salvage lesson preserved
- Kept: scope-discipline absolute rule, salvage-flow logic, turn-budget warnings

### code-review/CLAUDE.md
- Changed: title "Go idiom compliance" → "TypeScript idiom compliance"
- Changed: "### Go-Specific" subsection → "### TypeScript-Specific" with refreshed bullets
- Changed: `go.mod` → `package.json`
- Changed: must-run commands `go vet / staticcheck / go test -race` → `pnpm typecheck / pnpm lint / pnpm test`
- Changed: three example output lines `file.go:42` → `file.ts:42`
- Kept: severity-level taxonomy, security-review label-gating, mechanical-contract rules

### documentation/CLAUDE.md
- No changes — file was already clean of Go references (verified with grep).

## Out of scope (deferred to a separate ticket)

- Pyrycode → v2-dispatcher branding (agent titles, `mcp__qmd__query(collection: "pyrycode-docs", …)`, `gh --repo pyrycode/pyrycode` commands)
- Pyrycode incident references (#29, #40, etc.) — these ARE the lessons, kept verbatim per ticket AC #5
- `pyrycode-docs` QMD collection references — left intact; whether the v2 agents need their own QMD collection is a separate question

## Verification

```bash
grep -niE '\bgo\b|golang|go (test|vet|build|fmt)|gofmt|\.go\b' <files>
```

Returns only acceptable false positives ("go ahead", "ago", "go straight", "go through", "go to", "go deeper").
```

## Concurrency model

N/A — pure doc-editing pass with no runtime behavior.

## Error handling

The only failure mode worth pre-empting: cloning the sibling repo into the worktree, which would let the dispatcher's auto-commit safety net push the entire sibling repo's contents to `feature/16`. Mitigated above by clear "clone to /tmp" instruction.

A secondary failure mode is the grep verification returning hits the developer dismisses as false positives without checking. To prevent: the verification grep includes `\.go\b` (catches `file.go:42` even in code fences), and the AC explicitly enumerates which false positives are acceptable. Anything not on that list must be re-edited.

## Testing strategy

Three checks before opening the PR:

1. **Grep cleanliness.** The verification command in the workflow above. Output must contain only the enumerated false positives ("go ahead", "ago", "go straight", "go through", "go to", "go deeper").
2. **Lesson preservation spot-check.** For each of the five preserved lesson areas, confirm the rule still reads coherently:
   - **Sizing** — po/CLAUDE.md's "No `size:m` rationalization escape" + architect/CLAUDE.md's red-line list still intact
   - **Anti-rationalization** — architect/CLAUDE.md's smell-phrase list ("mechanical edits", "collapsible", etc.) intact
   - **File-overlap** — architect/CLAUDE.md's branch-overlap check shell block still teaches the same procedure, only the example filenames changed
   - **Salvage flow** — developer/CLAUDE.md's `#128` and `#155` worked examples still teach "file the out-of-scope bug, don't fix in-place"
   - **Predicate-completeness** — anything in code-review/CLAUDE.md or developer/CLAUDE.md mentioning predicate audits stays intact
3. **PR description completeness.** Per-file changelog covers all 5 (+ "no changes" for the 6th) files. AC #6 explicitly tests for this.

## Open questions

- **`pyrycode-docs` QMD collection references.** Five of six files contain `mcp__qmd__query(collection: "pyrycode-docs", …)`. These will return Pyrycode-project docs when an agent dispatched against *this* repo executes them. Not in scope for this ticket (the ticket is Go-flavour only), but it's the next bug to chase — flag it in the PR description's "Out of scope" section so it doesn't get lost. A follow-up ticket should decide whether v2 needs its own QMD collection or whether the references should be removed entirely.
- **Worked example #155 specificity.** The lesson is "test exposed a pre-existing bug in code outside the diff". Currently the example reads as Pyrycode-internal mechanics. Generalizing too far might bleach out the specificity that makes the lesson stick. Erring toward generalization per AC #4, but the developer should re-read the example after editing and ask "does this still feel concrete enough to remember?" If it bleaches to abstract advice, prefer a shorter mention that points to the original Pyrycode incident.
- **The "go straight to commit" / "go through" / etc. false positives.** Listed in the verification grep as acceptable. If the grep finds new ones not on the list, do not auto-dismiss — read the sentence to confirm it's truly false positive (e.g. "go-getter" would be a Go cultural reference disguised as English). When in doubt, paraphrase to remove the ambiguity.
