# Spec: `src/salvage/gate.ts` — `shouldAttemptSafeSalvage` (#69)

## Files to read first

- `src/config/env.ts:56-64` — existing `SALVAGE_GATES` parse path. Today it splits on `;` only, into `Config.salvageGates: readonly string[]`. This ticket does NOT touch `env.ts`; see "Open questions" for the follow-up about reconciling the two parsers.
- `src/pipeline/sizing.ts` — reference shape for a small pure-functions module (top-of-file rationale comment, named exports, no I/O).
- `test/pipeline/sizing.test.ts` — vitest layout, `describe`/`it` style, import path convention (`../../src/...ts` with the `.ts` extension).
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — this rule is the reason the runner is injected. Salvage lives in `src/salvage/` (not `src/pipeline/`) but the same pure/edge split applies: the *decision* module stays pure, the subprocess call sits behind a function passed in.
- `CLAUDE.md` § "Test-first" — RED → GREEN → REFACTOR. Write `test/salvage/gate.test.ts` first.

## Context

When a Claude agent exits with `max_turns`, the dispatcher considers opening a draft PR with the agent's partial work for human review (the "safe salvage" path). Operators want to gate this on per-workspace checks — typecheck, unit tests, lint — so the repo isn't littered with PRs for unbuildable runs.

Driver: env var `SALVAGE_GATES`, a comma- or semicolon-separated list of shell commands. Salvage proceeds only if every command exits 0. An unset/empty value means "operator has not opted in" → no PR.

This ticket lands the **pure decision module** only. The salvage orchestrator (a later ticket) wires it up and decides what to do with the verdict.

## Design

### Module layout

New directory + file:

```
src/salvage/gate.ts        # this ticket
test/salvage/gate.test.ts  # this ticket
```

No `src/salvage/index.ts` barrel — per CLAUDE.md § "Don't", internal imports are direct.

### Public surface

```typescript
// src/salvage/gate.ts

export type GateRunner = (cmd: string) => Promise<number>;

export function parseSalvageGates(raw: string | undefined): readonly string[];

export function shouldAttemptSafeSalvage(
  gates: string | undefined,
  run: GateRunner,
): Promise<boolean>;
```

- `GateRunner` — DI seam. Tests pass a fake; the orchestrator (later ticket) passes a thin wrapper around `node:child_process` (e.g. `execFile` or `spawn` resolving to the child's exit code). The runner resolves to a number, not throws — non-zero exits are a normal "gate failed" signal, not an exception. (Edge case: see "Error handling" for what `shouldAttemptSafeSalvage` does if the runner *does* throw.)
- `parseSalvageGates` is exported separately so tests can pin parser behaviour directly without going through the async path, and so future callers (e.g. a `--print-gates` debug command) don't need a runner just to inspect the parse result.

### Parser behaviour

`parseSalvageGates(raw)`:

1. If `raw` is `undefined` → return `[]`.
2. Split on the regex `/[,;]/` (single split — neither separator has precedence; the AC treats them as interchangeable).
3. Trim each segment.
4. Filter out empty segments (handles leading, trailing, and adjacent separators, plus whitespace-only input).
5. Return the resulting `readonly string[]` (freeze it via `Object.freeze` for consistency with `env.ts:57`).

This is deliberately the *only* place in the salvage module that knows the env-var format. `shouldAttemptSafeSalvage` delegates to it.

### Decision function

```typescript
export async function shouldAttemptSafeSalvage(
  gates: string | undefined,
  run: GateRunner,
): Promise<boolean> {
  const cmds = parseSalvageGates(gates);
  if (cmds.length === 0) return false; // unset / empty / whitespace-only → no opt-in
  for (const cmd of cmds) {
    const code = await run(cmd);
    if (code !== 0) return false;
  }
  return true;
}
```

**Sequential + short-circuit on first failure.** The AC permits either ordering; sequential short-circuit is the cheaper default — typecheck failing means there is no point spending CPU on the test suite. Order of the parsed array matches the operator's env-var order, so operators can put the fastest gate first.

### Concurrency model

None within this module. The function awaits each `run(cmd)` in series. Caller (orchestrator) owns wall-clock budgeting and any `AbortSignal` plumbing — that pattern lives at the edges, not in this pure-ish decision module.

## Error handling

- **Runner resolves to non-zero exit code** — normal "gate failed" path, function returns `false`. No throw.
- **Runner throws (e.g. command not found, child process spawn error)** — by contract, the runner SHOULD resolve to a numeric exit code even for spawn failures (the orchestrator's wrapper will translate spawn errors to a sentinel non-zero code, e.g. `127`). If a buggy runner throws, the rejection propagates to the caller; this module deliberately does NOT swallow it. Rationale: a runner that throws is a programming error in the orchestrator, not a salvage-gate failure — swallowing would mask the bug and risk an `await run(cmd)` rejection getting silently re-interpreted as "all gates passed."
- **Empty parser output** — already handled (returns `false`).

No try/catch in this file.

## Testing strategy

`test/salvage/gate.test.ts` — vitest, mirroring the `sizing.test.ts` layout.

Two top-level `describe` blocks:

### `describe("parseSalvageGates")`

Pin the parser independently from the async path. Cases:

- `undefined` → `[]`
- `""` → `[]`
- `"   "` (whitespace-only) → `[]`
- `"pnpm typecheck"` → `["pnpm typecheck"]`
- `"a;b"` → `["a", "b"]`
- `"a,b"` → `["a", "b"]`
- `"a, b ; c"` (mixed separators, whitespace) → `["a", "b", "c"]`
- `";a;"` (leading/trailing separator) → `["a"]`
- `",,a;;b,"` (adjacent separators) → `["a", "b"]`

### `describe("shouldAttemptSafeSalvage")`

Use a recording fake runner so tests assert both the verdict AND the call sequence (proves short-circuit-on-failure). Suggested helper:

```typescript
function recordingRunner(codes: Record<string, number>) {
  const calls: string[] = [];
  const run = async (cmd: string) => {
    calls.push(cmd);
    if (!(cmd in codes)) throw new Error(`unexpected cmd: ${cmd}`);
    return codes[cmd];
  };
  return { run, calls };
}
```

Cases (each maps to an AC bullet):

- Unset gates (`undefined`) → resolves `false`, runner never invoked. **(AC: unset → false)**
- Empty string gates (`""`) → resolves `false`, runner never invoked. **(AC: empty → false)**
- Whitespace-only gates (`"   "`) → resolves `false`, runner never invoked. **(AC: whitespace-only → false)**
- Single gate, exits 0 → resolves `true`, runner called exactly once with the parsed command. **(AC: single pass → true)**
- Single gate, exits non-zero (e.g. 1) → resolves `false`. **(AC: single fail → false)**
- Two gates, both exit 0 → resolves `true`, both called in declaration order.
- Two gates, first fails → resolves `false`, second runner NOT invoked (short-circuit). **(AC: mixed pass/fail → false)**
- Two gates, second fails → resolves `false`, both invoked.
- Comma-separated input (`"a,b"`) where both exit 0 → resolves `true`. **(AC: comma separator)**
- Semicolon-separated input (`"a;b"`) where both exit 0 → resolves `true`. **(AC: semicolon separator)**
- Whitespace around commands (`" a ; b "`) trimmed before runner call → runner receives `"a"` and `"b"`, not the padded forms. **(AC: trim)**

All eleven cases run with the in-process fake runner — no `child_process` import anywhere in `test/salvage/`.

## Open questions

1. **Reconciling parsers with `env.ts:56-64`.** `parseConfig` already pre-parses `SALVAGE_GATES` into `Config.salvageGates: readonly string[]` using `;` only. After this ticket lands, the codebase has two parsers with different separator sets. The intended end state (per AC: the gate function takes raw `string | undefined`) is that the orchestrator passes the raw env value, not `Config.salvageGates`. Resolution options for a follow-up ticket:
   - (a) Drop `salvageGates` from `Config` and have the orchestrator read raw `SALVAGE_GATES` from the env it already gets injected. Cleanest.
   - (b) Widen `env.ts`'s parser to also split on `,`. Two parsers but consistent.
   - (c) Keep both as-is and accept the drift; the gate module is the source of truth, `Config.salvageGates` becomes dead.
   This ticket does NOT pick a winner — it lands the gate per the AC. Flag for the salvage-orchestrator ticket's architect run.

2. **Shell semantics.** The AC says commands are "shell commands." The runner is DI'd, so this module doesn't care how they execute — but the orchestrator's runner wrapper will need to decide between `spawn(cmd, { shell: true })` (allows pipes/redirects/env interpolation) vs. `execFile` (no shell, safer). Out of scope for #69; mention in the orchestrator spec.

## Size & scope

- **Production lines (estimate):** ~30 lines across one new file. Parser ~10 lines, decision function ~10 lines, types + header comment ~10 lines.
- **Files touched:** 2 new (`src/salvage/gate.ts`, `test/salvage/gate.test.ts`). 0 modified.
- **New exported types:** 1 (`GateRunner`). New exported functions: 2 (`parseSalvageGates`, `shouldAttemptSafeSalvage`).
- **Edit fan-out:** 0 consumers (orchestrator is a later ticket).
- **Verdict:** Solid XS. No red lines tripped.

## Implementation checklist (for the developer)

1. Create `test/salvage/gate.test.ts` first with the eleven cases above; run `pnpm test` to confirm RED (module doesn't exist yet).
2. Create `src/salvage/gate.ts` with the surface above.
3. Run `pnpm typecheck && pnpm test` — both green.
4. Top-of-file comment in `gate.ts` should briefly note: (a) this is a pure decision module, runner is DI'd per CLAUDE.md's pure/edge rule; (b) separators are `,` and `;`, whitespace trimmed, empties discarded; (c) short-circuit-on-first-failure is the chosen ordering. Keep it under ~10 lines — match the tone of `sizing.ts:1-8`.
5. No barrel, no re-exports elsewhere, no edits to `env.ts` or anywhere outside `src/salvage/` and `test/salvage/`.
