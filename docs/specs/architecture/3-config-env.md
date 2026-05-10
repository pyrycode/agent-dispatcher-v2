# Spec: src/config/env.ts — .env loading + validation (#3)

## Files to read first

- `src/paths/agents-root.ts:1-29` — empty-string-as-unset convention; pure-resolver shape (typed opts in, normalized value out, named throw).
- `src/paths/target-root.ts:1-27` — same convention applied with a derived fallback; pattern this module's `loadConfig` wrapper mirrors (thin I/O wrapper around a pure core).
- `test/paths/agents-root.test.ts` — colocated test layout (`test/<area>/<name>.test.ts`), Vitest `describe`/`it`/`expect` style, regex error-message assertions (`toThrow(/AGENTS_REPO_PATH/)`). Mirror this exactly.
- `test/paths/target-root.test.ts` — second example of the same test pattern; pay attention to "throws when both are empty strings" coverage.
- `package.json` — confirms Node `>=22` (so Node-22 built-ins are available), `vitest` is the test runner, no `dotenv` dep currently.
- `CLAUDE.md` § "Architectural rules" — 200-line hardcap, pure-functions-at-the-edges rule, test-first rule. This module is a textbook fit: pure `parseConfig` core, thin I/O wrapper.
- `docs/PROJECT-MEMORY.md` § "Where things live" — confirms the spec path you're reading and the codebase-summary path the developer will write afterward.

## Context

Downstream dispatcher modules (`pipeline/`, `loop/`, `dispatch/`, `github/`, `claude/`) need a typed configuration object. This ticket lands the single source of truth for environment data: read `<agentsRoot>/.env`, validate, return a frozen `Config`. Subsequent modules import the `Config` type and consume it via constructor injection — no `process.env` reads outside this file.

`AGENTS_REPO_PATH` is intentionally **not** consumed here. The launcher reads it via `paths/agents-root.ts` to locate the `.env` file in the first place, then threads `agentsRoot` into `loadConfig`. Putting `AGENTS_REPO_PATH` inside `.env` would be a chicken-and-egg loop.

`TARGET_REPO_PATH` is validated only as "non-empty string when set." The actual path resolution / fallback to `parent-of(agentsRoot)` lives in `paths/target-root.ts` (already merged in #2). Keep concerns separate.

Out of scope: anything that consumes `Config`. This is a leaf module.

## Design

### File layout

```
src/config/env.ts          # the module — both parseConfig and loadConfig
test/config/env.test.ts    # colocated tests
```

One file, both exports. Splitting `parseConfig` into its own file is premature — they share the `Config` type and a small set of internal validators, and the file lands well under the 200-line hardcap. (Estimate: ~120–150 lines including JSDoc/comments and the validator helpers; PO's 80–100 estimate is the floor.)

### Public surface

```typescript
// src/config/env.ts

export interface Config {
  readonly githubOwner: string;
  readonly githubRepo: string;
  readonly projectNumber: number;
  readonly githubToken: string;
  readonly ownerType: "user" | "organization";
  readonly targetRepoPath: string | undefined;
  readonly targetDefaultBranch: string;
  readonly salvageGates: readonly string[];
  readonly pyryMaxConcurrent: number;
  readonly discordWebhookUrl: string | undefined;
  readonly pyryLogRetentionDays: number;
}

export interface LoadConfigOpts {
  agentsRoot: string;
}

/** Pure: validate a raw env record, return a frozen Config. Throws on invalid. */
export function parseConfig(env: Record<string, string | undefined>): Config;

/** Thin I/O wrapper: read <agentsRoot>/.env, merge over process.env, parse. */
export function loadConfig(opts: LoadConfigOpts): Config;
```

### Why two functions

Mirrors the established `paths/` pattern: pure core + thin wrapper. Tests target `parseConfig` exclusively — no temp-dir setup, no fs mocking, no `process.env` mutation. `loadConfig` gets a single smoke test in the test file (real fs read against a fixture under `test/config/fixtures/`), not eleven branch tests.

### Immutability

Use `readonly` on every interface field (compile-time guard) **and** `Object.freeze(config)` before returning (runtime guard for any consumer that bypasses TypeScript). The `salvageGates` array uses `readonly string[]` plus `Object.freeze(arr)` — shallow freeze is sufficient because every field is a primitive or a frozen primitive array. No deep freeze needed.

### `.env` parsing

Node 22 ships `process.loadEnvFile(path)`, but it mutates `process.env` globally and gives no return value — unsuitable for a pure pipeline module and untestable without test-pollution cleanup. **Don't use it.**

Implement a tiny line-based parser inside `loadConfig` (~20 lines, kept private — not exported):

```typescript
function readEnvFile(path: string): Record<string, string> {
  const text = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;                      // tolerate malformed lines silently — matches dotenv
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip a single matching pair of surrounding double or single quotes.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
       (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== "") out[key] = value;
  }
  return out;
}
```

No backslash-escape handling, no multi-line values, no `${VAR}` interpolation. v1 didn't need them; this is a private internal config file, not a user-supplied template. If a future ticket needs them, escalate then.

### `loadConfig` body

```typescript
export function loadConfig(opts: LoadConfigOpts): Config {
  const envFilePath = resolve(opts.agentsRoot, ".env");
  const fileEnv = existsSync(envFilePath) ? readEnvFile(envFilePath) : {};
  // process.env wins over .env: the launcher may inject overrides (CI, test harness).
  // .env provides defaults for the developer's local shell.
  const merged: Record<string, string | undefined> = { ...fileEnv, ...process.env };
  return parseConfig(merged);
}
```

**Missing `.env` is not an error.** If every required var is present in `process.env` (CI, container, manual export), the module works fine without a file. `parseConfig`'s required-var checks catch the actually-missing case.

**Precedence: `process.env` overrides `.env`.** Standard convention, matches dotenv's `override: false` default and what most Node devs expect. Lets the launcher inject test/CI overrides without rewriting the file.

### `parseConfig` internals — validator helpers

Three small private helpers, each ~5–10 lines:

```typescript
// Empty-string-as-unset, consistent with paths/.
function readVar(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function requireVar(env: Record<string, string | undefined>, key: string): string {
  const v = readVar(env, key);
  if (v === undefined) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function parseIntegerVar(
  raw: string,
  key: string,
  opts: { min: number },
): number {
  // Strict: only digits (with optional leading -). Reject "1.0", "1abc", " 1 ".
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Invalid ${key}: expected integer, got "${raw}"`);
  }
  const n = Number.parseInt(raw, 10);
  if (n < opts.min) {
    throw new Error(`Invalid ${key}: must be >= ${opts.min}, got ${n}`);
  }
  return n;
}
```

Then the body is a flat sequence of `requireVar`/`readVar`/`parseIntegerVar` calls assembling the `Config`, with two inline validations for `OWNER_TYPE` (literal-set check) and `SALVAGE_GATES` (split + trim + filter).

### Per-var rules (reference table for the developer)

| Var | Required? | Validation | Default |
| --- | --- | --- | --- |
| `GITHUB_OWNER` | yes | `requireVar` (non-empty string) | — |
| `GITHUB_REPO` | yes | `requireVar` | — |
| `PROJECT_NUMBER` | yes | `requireVar` → `parseIntegerVar({ min: 1 })` | — |
| `GITHUB_TOKEN` | yes | `requireVar` — **never echo value in errors** | — |
| `OWNER_TYPE` | no | must be `"user"` or `"organization"` | `"user"` |
| `TARGET_REPO_PATH` | no | non-empty string when set; no path resolution here | `undefined` |
| `TARGET_DEFAULT_BRANCH` | no | non-empty string | `"main"` |
| `SALVAGE_GATES` | no | split on `;`, trim each, drop empties | `[]` (see decision below) |
| `PYRY_MAX_CONCURRENT` | no | `parseIntegerVar({ min: 1 })` | `2` |
| `DISCORD_WEBHOOK_URL` | no | non-empty string when set; no URL-shape check | `undefined` |
| `PYRY_LOG_RETENTION_DAYS` | no | `parseIntegerVar({ min: 0 })` | `30` |

### `GITHUB_TOKEN` redaction

The naive bug: `requireVar`'s "Missing required env var: GITHUB_TOKEN" is fine (no value echoed). The hazard is later: if anyone adds a "value too short" or "must start with `ghp_`" check, the temptation is `throw new Error(\`Invalid GITHUB_TOKEN: "${raw}"\`)` — which leaks the token. This module **does not** validate `GITHUB_TOKEN` shape beyond non-empty. There is one explicit unit test (`AC #5`) that asserts the thrown error never contains the token string. That test is the canary for any future regression.

### `SALVAGE_GATES` default — decision

PO's tech notes flag this as unresolved. **Decision: default to `[]` (salvage opt-in).**

Rationale: v1's `["go vet ./...", "go build ./..."]` was Go-toolchain-specific. v2 dispatches against arbitrary target repos (the agents repo merely *configures* the dispatcher; the target repo is whatever consumer points `TARGET_REPO_PATH` at it). Picking `["pnpm typecheck", "pnpm test"]` would silently assume every consumer is a pnpm/Node project — a regression for Go consumers (e.g. the original `pyrycode` Go repo). Each consumer's `.env` declares its own gates. The empty default is the only choice that doesn't make a consumer-stack assumption.

This is a behavior decision that should land in `docs/knowledge/decisions/` as ADR 0002 — flag in **Open questions** for the developer to draft the ADR alongside the implementation.

### Empty-string-as-unset

Every var follows `paths/`'s rule: `KEY=` in `.env` reads as `""`, which is treated as unset (so optional vars get their default; required vars throw). `readVar` enforces this for both branches uniformly.

### Error message contract

- Missing required: `Missing required env var: <KEY>`
- Invalid integer: `Invalid <KEY>: expected integer, got "<raw>"` — except for `GITHUB_TOKEN`, which never appears here
- Below minimum: `Invalid <KEY>: must be >= <min>, got <n>`
- Invalid `OWNER_TYPE`: `Invalid OWNER_TYPE: expected "user" or "organization", got "<raw>"`

The format is consistent enough that downstream callers can string-match on `Missing required env var:` or `Invalid <KEY>:` if they ever need to (none currently do).

## Files touched

- `src/config/env.ts` — new, ~120–150 lines
- `test/config/env.test.ts` — new, ~150–200 lines (lots of small validation cases)
- `test/config/fixtures/.env.valid` — new, 10–15 lines (one fixture for the `loadConfig` smoke test)

## Testing strategy

Mirror `test/paths/`'s shape and density. All branch coverage targets `parseConfig`; `loadConfig` gets one smoke test.

### `parseConfig` (the bulk)

Group with `describe("parseConfig", () => { ... })`. Inside:

1. **Happy path** — full valid config, assert every field on the returned object.
2. **Required vars** — for each of `GITHUB_OWNER`, `GITHUB_REPO`, `PROJECT_NUMBER`, `GITHUB_TOKEN`:
   - missing entirely → throws `/Missing required env var: <KEY>/`
   - empty string → throws same
3. **`PROJECT_NUMBER`** validation — `"abc"` throws `/expected integer/`, `"0"` throws `/must be >= 1/`, `"1.5"` throws `/expected integer/`, `" 1 "` throws (whitespace not stripped before regex test — confirms strict parsing).
4. **`OWNER_TYPE`** — `"user"` returns `"user"`; `"organization"` returns `"organization"`; `"User"` throws (case-sensitive); `"orgnization"` throws (typo); unset returns `"user"` default.
5. **`TARGET_REPO_PATH`** — set returns the string; unset returns `undefined`; empty-string returns `undefined`.
6. **`TARGET_DEFAULT_BRANCH`** — set returns string; unset returns `"main"`.
7. **`SALVAGE_GATES`** — `"a;b;c"` returns `["a","b","c"]`; `"a; b ; c"` returns `["a","b","c"]` (trimmed); `"a;;b"` returns `["a","b"]` (empties dropped); `""` returns `[]`; unset returns `[]`.
8. **`PYRY_MAX_CONCURRENT`** — `"3"` → 3; unset → 2; `"0"` throws; `"-1"` throws; `"abc"` throws.
9. **`DISCORD_WEBHOOK_URL`** — set returns string; unset returns `undefined`. (No URL check, so no invalid-URL test.)
10. **`PYRY_LOG_RETENTION_DAYS`** — `"7"` → 7; `"0"` → 0 (rotation disabled); unset → 30; `"-1"` throws; `"abc"` throws.
11. **Token redaction (AC #5)** — set every required var validly, then mutate the env to make `GITHUB_OWNER` invalid (e.g. delete it). Catch the thrown error, assert `error.message` does NOT contain the token value (use a recognizable canary like `"sk-canary-token-do-not-leak"`). Repeat for *every* throw path that runs after `GITHUB_TOKEN` is read — at minimum: missing `GITHUB_REPO` (read after `GITHUB_TOKEN`), invalid `PROJECT_NUMBER`, invalid `OWNER_TYPE`. The point is to lock in the contract, not to enumerate; one canary assertion per throw site is enough.
12. **Immutability** — assert `Object.isFrozen(config)` is true; assert `Object.isFrozen(config.salvageGates)` is true; assert assigning to `(config as any).githubOwner = "x"` throws in strict mode (or no-ops with a frozen-property write — verify either behavior).

### `loadConfig` (one test)

`describe("loadConfig", ...)` with one happy-path test pointing at `test/config/fixtures/.env.valid`. Build a temp `agentsRoot` containing only that `.env`, call `loadConfig({ agentsRoot })`, assert one or two fields. Don't re-cover `parseConfig` branches here.

### Test pollution guard

`loadConfig` reads `process.env`. Tests for `loadConfig` MUST snapshot and restore relevant env vars (Vitest's `vi.stubEnv` + `vi.unstubAllEnvs` in `afterEach`, or manual save/restore). Otherwise a developer's local `GITHUB_TOKEN` leaks into the test run.

`parseConfig` tests pass an explicit env object — no `process.env` access — so they're immune.

## Open questions

- **ADR for `SALVAGE_GATES = []` default.** Recommend developer drafts `docs/knowledge/decisions/0002-salvage-gates-default-empty.md` capturing the consumer-stack-agnostic rationale. Small (~30 lines), but it pre-empts the next architect re-litigating the question.
- **`PYRY_LOG_RETENTION_DAYS` semantics of `0`.** Spec says `0` disables rotation. This module just parses the value; the consumer (rotation module, not yet written) interprets it. No action here, just flagging that the meaning is set in the AC and downstream code must honor it.
- **`.env` parser robustness.** The 20-line parser handles the cases v1 actually used. If a `.env` value contains `#`, the current logic does NOT strip a trailing inline comment — `KEY=value # comment` reads value as `"value # comment"`. dotenv strips inline comments only outside quotes; v1's parser did not. **Decision: don't strip inline comments.** Fewer surprises, easier to reason about. Document in the JSDoc on `readEnvFile`.

## Out of scope (explicit non-goals)

- Consuming `Config` from any other module. Pure leaf.
- `AGENTS_REPO_PATH` validation — handled by the launcher via `paths/agents-root.ts` before `loadConfig` runs.
- `TARGET_REPO_PATH` resolution / fallback — handled by `paths/target-root.ts`. This module only validates the raw string shape.
- Schema-validation libraries (zod, valibot). The module is small, the rules are flat, and adding a runtime dep for ~10 fields is over-engineering for this scope. Revisit if the field count crosses ~25.
- Multi-environment (`.env.production`, `.env.local`) layering. Single `.env` is the v1 contract; layering is YAGNI here.
- Logging / debug output. `loadConfig` returns a value or throws; it doesn't log. The launcher decides what to print.
