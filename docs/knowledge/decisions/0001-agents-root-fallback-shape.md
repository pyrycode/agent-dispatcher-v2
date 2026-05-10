# ADR 0001 — `resolveAgentsRoot` ships no launcher-relative fallback

**Status:** Accepted (2026-05-10, ticket #2)

## Context

v1's `resolveAgentsRepoRoot` derived a fallback by computing `__dirname + "../.."` from the dispatcher source location. That worked because v1's source lived inside each consumer's `agents/dispatch/src/` subtree — there was a fixed positional relationship between source and target.

v2's source ships from its own repo (`agent-dispatcher-v2`). It has no fixed relationship to any consumer's `agents/`. The architect needed to choose how `resolveAgentsRoot` should behave when the env var is unset:

- (a) Drop the fallback entirely; require `AGENTS_REPO_PATH`.
- (b) Walk up from a caller-supplied start dir looking for a marker (e.g., `.git`, `agents/`).
- (c) Keep a launcher-relative offset for `pnpm exec tsx src/dispatch-bin.ts` ergonomics.

## Decision

**Option (a).** The resolver derives no fallback of its own. The dispatch-bin call site passes `fallback: undefined` and requires `AGENTS_REPO_PATH` to be set.

The `fallback` parameter remains in the signature so:
- tests can exercise the second branch without touching env;
- a future caller (e.g., a launcher script that walks up looking for an `agents/` marker) can derive one and pass it in without changing the resolver.

## Rationale

- **(c) doesn't work.** Any launcher-relative offset would hardcode a v1-specific layout into v2's first module — anti-portability for forks.
- **(b) is a defense for an unobserved failure mode.** v1 consumers always invoked the dispatcher via a launcher script (`bin/pyry-start`) that set `AGENTS_REPO_PATH` explicitly. No real call site ever fell through to the marker walk. CLAUDE.md "Don't write a defense for a failure mode that hasn't been observed."
- **(a) keeps the resolver pure and the failure mode loud.** A misconfigured environment throws a clear error naming the env var, instead of silently picking a wrong path via marker heuristics.

## Consequences

- The dispatch entry point (when `src/dispatch/` lands) MUST set or surface `AGENTS_REPO_PATH`. There is no convenience default.
- If a future use case (e.g., bare `pnpm exec tsx src/dispatch-bin.ts` ergonomics) demonstrates real friction, the fix lives in the caller — derive a fallback there and pass it to `resolveAgentsRoot`. The resolver itself stays unchanged.
- `resolveTargetRoot` is unaffected; it still derives `parent-of(agentsRoot)` as its fallback because that derivation IS the load-bearing semantic ("agents/ lives INSIDE the target repo"), not a convenience.
