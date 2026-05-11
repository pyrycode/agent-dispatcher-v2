# Spec: `src/github/blocked-by.ts` — GraphQL `addBlockedBy` mutation wrapper (#37)

## Files to read first

- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — sets the file-size ceiling; this module is the smallest of the three `src/github/` siblings (~20–40 production lines).
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — explicitly names `src/github/` as the I/O edge. This module is allowed to `await` and to talk to the network via the injected transport.
- `CLAUDE.md` § "Belt-and-suspenders" — the deterministic GraphQL primitive that backstops the architect's prose ("set the dependency"). Two stochastic rules verifying each other share the same failure mode; pairing prose with a deterministic mutation wrapper is the right shape.
- `CLAUDE.md` § "Don't" — bullet "Don't import from a barrel file (`src/index.ts`) inside `src/`"; bullet "Don't write a defense for a failure mode that hasn't been observed" (constrains: no retry, no fallback, no message rewriting).
- `CLAUDE.md` § "Test-first" — RED → GREEN → REFACTOR is mandatory. The integration tests in `test/github/blocked-by.test.ts` go in first.
- `src/github/project-client.ts:42-45` — canonical `GraphQLTransport` type definition. This module imports that type rather than redeclaring it. Single source of truth for the DI seam.
- `src/github/project-client.ts:101-123` — precedent for "no try/catch around the transport call; propagate verbatim." The owner-field selection plus the `Could not resolve to a User` canary path is the pattern this module follows for invalid-node-ID errors.
- `test/github/project-client.test.ts:8-32` — the hand-rolled `makeTransport(routes)` pattern with a `calls` log. This test file mirrors that shape inline; do **not** lift the helper into `test/github/_helpers/transport.ts` yet — promote at the moment a third consumer appears (same rule that kept `hasNeedsReworkLabel` private in #6 until a second user landed).
- `test/github/project-client.test.ts:120-143` — precedent for "GraphQL error propagates verbatim" assertions: canary substring + `calls.length === 1` (no retry). Test #2 in this module mirrors that exact shape.
- `docs/specs/architecture/19-github-project-client.md` § "Why no `@octokit/graphql` import here" — establishes the dep-deferral posture this module inherits. `package.json` is **not** modified by this ticket.
- `docs/PROJECT-MEMORY.md` § "src/github/ I/O surface (#19)" — codifies the patterns this module reuses (DI'd transport, no fallback, narrow types, no rate-limit/cache concerns at the primitive layer).
- `biome.json:5-19` — formatter rules biome enforces (double quotes, trailing commas all, semicolons always, 100-col line width, 2-space indent). Any line over 100 cols breaks `pnpm lint`.
- `package.json:11-21` — confirms `pnpm typecheck` / `pnpm test` / `pnpm lint` are the gates. `@octokit/graphql` is not a dep and this ticket does not add one.

The ticket body itself enumerates the six ACs and the GraphQL mutation shape. Re-read those before writing the wrapper — the mutation's variable names (`issueId` for the blocked issue, `blockingIssueId` for the blocker) map directly into the test fixture assertions.

## Context

This ticket lands the **deterministic primitive** the architect's split flow uses to mark a child sub-issue as blocked by an earlier child. Native sub-issue blocking, not a custom `blocked-by:#N` label, because the dispatcher's `hasOpenBlockers` predicate (#6, merged) reads the native GraphQL relationship. Two stochastic rules verifying each other share the same failure mode (CLAUDE.md "Belt-and-suspenders") — the architect's prose ("set the dependency") is ~80% reliable; the dispatcher needs the other 20% guarantee that a deterministic GraphQL primitive is available for the call site to invoke.

This wrapper takes **node IDs**, not issue numbers. The GraphQL `addBlockedBy` mutation requires node IDs natively; resolving numbers to node IDs would require an extra `gh api graphql` round-trip hidden inside this primitive — the cost should be visible at the call site. Callers that have only issue numbers resolve them through `src/github/issues.ts` (sibling ticket #35) before invoking this wrapper. Keeping resolution at the call site:

- Makes the per-call I/O cost legible (one round-trip per primitive).
- Keeps this module free of any cross-module dependency on the issues client. The two `src/github/` siblings are independent; the consumer composes them.
- Matches the established "narrow types at the boundary" posture from #6 / #19: this wrapper takes the exact shape the GraphQL mutation requires; widening to "accept either node IDs or numbers" would be a fallback path that obscures the cost.

The DI seam for the GraphQL transport is the same `GraphQLTransport` type established by `project-client.ts` (#19, merged). This module **imports** that type — single source of truth. The launcher (a later ticket) will instantiate one `GraphQLTransport` and inject it into both `project-client.ts` and `blocked-by.ts` callers. There is no second transport shape to introduce here.

Out of scope: any consumer (no architect-flow wiring; no number→nodeId resolver; no removeBlockedBy / blockedBy-query helpers; no caching). Sibling primitives (#35 issues, #19 project-client) are merged or in flight; consumers compose at a later ticket.

## Design

### File: `src/github/blocked-by.ts`

Single new file. Third file in `src/github/` (after `project-client.ts` from #19 and `issues.ts` landing in #35). Estimated 25–40 production lines; well under the 200-line hardcap.

#### Public surface

```ts
// src/github/blocked-by.ts

import type { GraphQLTransport } from "./project-client.ts";

/**
 * Mark `blockedNodeId` as blocked by `blockerNodeId` via GitHub's native
 * sub-issue relationship. Thin wrapper around the GraphQL `addBlockedBy`
 * mutation — no semantics added, no fallback, no retry, no caching.
 *
 * Both arguments are GitHub node IDs (`I_kw...`), not issue numbers.
 * Callers with only issue numbers resolve via `src/github/issues.ts`
 * (#35) before calling here; the round-trip cost stays visible.
 *
 * Errors from the transport — including invalid-node-ID GraphQL errors
 * — propagate verbatim. The contract is "the underlying error reaches
 * the caller intact."
 *
 * Naming: the GraphQL mutation's input fields are `issueId` (the
 * BLOCKED issue) and `blockingIssueId` (the BLOCKER). The argument
 * names here use `blockedNodeId` / `blockerNodeId` — the same role
 * spelled in plain English so the call site reads unambiguously
 * without referring back to the mutation shape.
 */
export function addBlockedBy(
  blockedNodeId: string,
  blockerNodeId: string,
  transport: GraphQLTransport,
): Promise<void>;
```

The implementation is a single `await transport(query, variables)` call followed by a discard. `Promise<void>` is the right return shape — the caller does not need confirmation; the absence of a thrown error IS the success signal. The mutation requests `issue { number }` in its selection set as a sanity round-trip per the ticket's mutation shape, but the response is intentionally discarded; surfacing it would speculate on a hypothetical caller that wants a logged number.

#### Why a free function (not a class)

`project-client.ts` (#19) is a class because it caches resolved IDs across method calls — the constructor invariant "project IDs are resolved" is what the static factory pattern protects. This module has **no state to cache** and **no precondition to protect**: a single mutation call with two arguments and a transport.

A class here would buy nothing — a `BlockedByClient.create(transport)` factory just so callers can do `client.addBlockedBy(a, b)` instead of `addBlockedBy(a, b, transport)` is API surface for no semantic gain. The free-function shape:

- Mirrors how the call site will read the AC ("call `addBlockedBy(blocked, blocker)`").
- Keeps the transport injection visible at every call site (the launcher will pass it explicitly).
- Avoids adding a third `src/github/*` class shape on top of `GitHubProjectClient` (#19) and `GitHubIssuesClient` (#35) — they're classes for state-binding reasons; this isn't one.

If a future ticket needs to bind `(transport)` once across many call sites, a thin wrapper is a non-breaking addition (e.g. a `BlockedByClient.create(transport)` adapter). Don't pre-build it.

#### Why import `GraphQLTransport`, not redeclare

`GraphQLTransport` is defined once in `project-client.ts` (#19). Importing keeps a single source of truth for the DI seam — when the launcher decides on the production transport (`@octokit/graphql.defaults({...})` or a `gh api graphql --jq` shell-out), it instantiates one and threads it through every consumer. Redeclaring would create two structurally identical types that drift the moment a future ticket widens the seam (e.g. to add an `AbortSignal` parameter).

CLAUDE.md "no barrels inside `src/`" forbids `src/index.ts` re-exports; it does **not** forbid sibling-module imports (`./project-client.ts`). The directory's existing layout — `src/github/project-client.ts` consumed by `src/github/issues.ts` (in #35's design) — already establishes this pattern.

#### Mutation GraphQL query

Single-line minified per the #19 precedent (multi-line indented queries pushed `project-client.ts` past the 200-line hardcap; same posture applies here for consistency, though this file is small enough either way):

```graphql
mutation($issueId: ID!, $blockingIssueId: ID!) {
  addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
    issue { number }
  }
}
```

Variables:

```ts
{ issueId: blockedNodeId, blockingIssueId: blockerNodeId }
```

The variable-name mapping is load-bearing: GitHub's `addBlockedBy` mutation takes `issueId` as the **blocked** issue (the one that becomes blocked) and `blockingIssueId` as the **blocker**. Reversing them at the call site silently sets the dependency the wrong way around — the test (§ "Test groups" #1) deep-equals the variables to pin this.

#### Implementation sketch

```ts
const ADD_BLOCKED_BY_MUTATION =
  "mutation($issueId:ID!,$blockingIssueId:ID!){addBlockedBy(input:{issueId:$issueId,blockingIssueId:$blockingIssueId}){issue{number}}}";

export async function addBlockedBy(
  blockedNodeId: string,
  blockerNodeId: string,
  transport: GraphQLTransport,
): Promise<void> {
  await transport(ADD_BLOCKED_BY_MUTATION, {
    issueId: blockedNodeId,
    blockingIssueId: blockerNodeId,
  });
}
```

That's the whole module body, plus a top-of-file comment block matching the `project-client.ts` / `issues.ts` shape (intent + invariants + what's deferred). No try/catch, no input validation, no fallback. CLAUDE.md "Don't write a defense for a failure mode that hasn't been observed" — empty-string node IDs would be a caller bug; the GraphQL transport returns the truth (`Could not resolve to an Issue`) which is more useful than a wrapper-thrown `Error("blockedNodeId is empty")`.

#### What does NOT land here (deferred per "Don't write a defense for a failure mode that hasn't been observed")

- **`removeBlockedBy` mutation.** Not on the AC; no observed call site. When the architect's split flow (or a future cleanup pass) needs to detach a relationship, it gets its own primitive in its own ticket.
- **`blockedBy` query helper.** The dispatcher already reads the native relationship via `hasOpenBlockers` (#6, pure predicate over a `Blocker[]` shape supplied by the I/O layer). The fetch is a different concern — likely lands in #20 (issues) or as a sibling primitive when the call site appears.
- **Number→nodeId resolution inside this primitive.** Architectural decision (see § Context); the cost stays visible at the call site.
- **Retry / backoff.** The injected transport handles its own resilience policy. This module is concerned with the mutation's semantics, not network resilience. Same posture as #19.
- **Rate-limit tracking.** Same boundary as #19 — defer until budget pressure is observed at the loop layer.
- **`@octokit/graphql` runtime dep.** The transport is interface-shaped; the launcher provides the implementation. `package.json` is unchanged.
- **Re-export from `src/index.ts`.** CLAUDE.md "Don't" bullet explicitly forbids barrel re-exports inside `src/`. Consumers import directly from `./github/blocked-by.ts`.

### Concurrency model

None. A single `await` on a single transport call. Concurrent calls to `addBlockedBy` are safe and uncoordinated (no shared state). If a caller wants to dedupe concurrent invocations on the same `(blocked, blocker)` pair, that's a wrapper concern (architect-flow module).

### Error handling

- The transport call's promise resolves on success (response is discarded).
- The transport call's promise rejects on **any** failure — invalid node ID, permissions, rate limit, transient network. The rejection propagates verbatim; no try/catch in this module, no message rewriting, no fallback path.
- Empty-string or malformed node IDs (`""`, `"not-a-node-id"`) are not validated client-side — the GraphQL transport returns the canonical error (`Could not resolve to a node with the global id of '...'`) which is the truth of the input being wrong. A wrapper-thrown validation error would speculate on the API's failure surface and lose information.

No try/catch inside this module. No "fail open." No silent fallback paths. The contract from #19 carries forward unchanged.

### File: `test/github/blocked-by.test.ts`

Mirrors the source path. Vitest, RED-first per CLAUDE.md. Estimated ~80–110 lines for two `it` blocks plus a small `makeTransport` helper inline.

#### Test transport pattern

Hand-rolled inline (do **not** import from `test/github/_helpers/`; that helper does not exist yet and the rule from #19 § "Open question 5" defers extraction until a third consumer appears — `project-client.test.ts` was the first; this is the second; #35's `issues.test.ts` uses a parallel `RestTransport` shape, not the GraphQL one). The pattern is identical to `test/github/project-client.test.ts:8-32`:

```ts
type Route = {
  match: (query: string, variables: Record<string, unknown>) => boolean;
  respond: (variables: Record<string, unknown>) => unknown | Promise<unknown>;
};

interface RecordingTransport {
  fn: GraphQLTransport;
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
}

function makeTransport(routes: readonly Route[]): RecordingTransport {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fn: GraphQLTransport = async (query, variables) => {
    calls.push({ query, variables });
    for (const r of routes) {
      if (r.match(query, variables)) return r.respond(variables);
    }
    throw new Error(`No route matched query: ${query.slice(0, 80)}...`);
  };
  return { fn, calls };
}
```

The `calls` log is the verification mechanism for "transport received the right query AND the right variable mapping." Tests assert on `calls[0]` directly — no mock library, no `expect(fn).toHaveBeenCalledWith(...)` indirection.

#### Test groups (each `it` maps to one AC bullet)

Two `describe` blocks, two `it` blocks total per the AC ("Integration tests cover: happy path; invalid node ID surfaces the GraphQL error verbatim").

1. **Happy path — valid node IDs → mutation succeeds (AC #4 happy-path row + AC #1 + AC #2)**
   - Transport route: query substring matches `addBlockedBy(input:` → returns `{ addBlockedBy: { issue: { number: 42 } } }`.
   - Caller invokes `await addBlockedBy("I_kwBlocked", "I_kwBlocker", t.fn)`.
   - Assert: the promise resolves (no throw).
   - Assert: `t.calls.length === 1` (exactly one transport call — no retry).
   - Assert: `t.calls[0].query.includes("addBlockedBy(input:")` is `true`.
   - Assert: `t.calls[0].variables` deep-equals `{ issueId: "I_kwBlocked", blockingIssueId: "I_kwBlocker" }`.

   The deep-equal on `variables` is the load-bearing assertion: it pins the **role mapping** (`blockedNodeId → issueId`, `blockerNodeId → blockingIssueId`). A future "let's swap these for symmetry" simplification would set the dependency the wrong way around, and this assertion catches it at PR time, not in production after the architect's split flow already ran.

2. **Invalid node ID surfaces the GraphQL error verbatim (AC #3 + AC #4 error-path row)**
   - Transport route: any query → throws `new Error("Could not resolve to a node with the global id of 'I_kwBogus'")`.
   - Caller invokes `addBlockedBy("I_kwBogus", "I_kwBlocker", t.fn)`.
   - Assert: the promise rejects with an `Error` whose `message` contains the canary substring `Could not resolve to a node`.
   - Assert: `t.calls.length === 1` — no fallback retry (mirrors `project-client.test.ts:142` posture).

   Use exact-substring match (not a `toThrow(/regex/)` over the literal) so the contract is "the error reaches the caller intact." If a future PR wraps the call in a try/catch that re-throws `new Error("addBlockedBy failed: " + cause.message)`, the canary still passes (substring is preserved) — but the `calls.length === 1` assertion catches any retry. Together, these two assertions lock the no-fallback, no-rewriting contract.

Each `it` block is short (~15–25 lines including the inline routing-table setup). Total test file: ~80–110 lines. No shared fixtures across tests; each builds its own routing table inline so a regression points at the exact failing scenario.

#### Why no test for "process.env / issueNumber not consulted" (AC #6)

AC #6 says: "Module does not read `process.env`, does not derive ordering from `issueNumber`, and does not import from `src/index.ts`." These are **structural** properties of the module, not behavioral. Code review enforces them; a runtime test would have to monkey-patch `process.env` or inspect the module's import graph, which is wasted ceremony. The biome lint pass + a manual import-graph review during PR are the right gates. If a future PR introduces a `process.env` read or a barrel import, lint + review catch it; no test row needed.

If the developer wants belt-and-suspenders here, a single `expect(fs.readFileSync("src/github/blocked-by.ts", "utf8")).not.toMatch(/process\.env/)` row would do it — but that's a test smell (asserting on source text). Keep the contract in the spec + code review; don't push it into runtime test goo.

### Implementation order (RED → GREEN, per AC)

1. Create `test/github/blocked-by.test.ts` with both `it` blocks, importing from `../../src/github/blocked-by.ts`. Run `pnpm test` → fails (file does not exist). RED.
2. Create `src/github/blocked-by.ts` with the import, the mutation constant, and the single `addBlockedBy` async function. Run `pnpm test` → both cases pass. GREEN.
3. Run `pnpm typecheck && pnpm lint` → both pass.
4. Append `### src/github/ blocked-by primitive (#37)` subsection to `docs/PROJECT-MEMORY.md` under the existing `### src/github/ I/O surface (#19)` and `### src/github/ issues REST surface (#35)` entries (the convention from prior tickets). Highlights to capture: free-function-not-class shape, role-mapping invariant (`blockedNodeId → issueId`, `blockerNodeId → blockingIssueId`), node-IDs-not-numbers boundary, deferred sibling primitives.
5. Append `docs/knowledge/codebase/37.md` matching the precedent in `19.md` / `35.md`.
6. Commit.

If any step fails out of order (e.g. you write the source first), discard and restart. CLAUDE.md is explicit: "Backfilling tests after the fact ships bugs first."

### Files touched

- `src/github/blocked-by.ts` — new, ~25–40 lines.
- `test/github/blocked-by.test.ts` — new, ~80–110 lines (two `it` blocks + inline `makeTransport` helper).
- `docs/PROJECT-MEMORY.md` — append `### src/github/ blocked-by primitive (#37)` subsection.
- `docs/knowledge/codebase/37.md` — new per-ticket implementation summary.

No edits to existing source. No `src/index.ts` re-export. **No `package.json` change** — `@octokit/graphql` is not added.

## Testing strategy

The two integration tests *are* the verification. There is no real-GitHub integration target; the hand-rolled `GraphQLTransport` fake is the boundary, exactly as the AC requires ("no real `gh` CLI invocations in tests").

The two load-bearing assertions:

- **Happy-path variables deep-equal** — locks the role mapping. A future "swap these for symmetry" or a refactor that derives variables from a `{ issueId, blockingIssueId }` opts shape (which would let callers accidentally pass them in the wrong role) breaks this assertion immediately, with a failure pointing at exactly the right line.
- **Error-path `calls.length === 1`** — locks the no-fallback contract. A future PR that adds a try/retry shim (e.g. retry on `RATE_LIMITED` errors) would either need to update this assertion (visible in the diff) or break it (caught in CI). Either outcome surfaces the deviation.

CI gate: `pnpm typecheck && pnpm test && pnpm lint` (the four steps already wired up by #1).

## Open questions

1. **Should the wrapper return the issue number from the response?** Spec says no — `Promise<void>`. The mutation's `issue { number }` selection set is a sanity round-trip the GraphQL API forces us to request (`addBlockedBy(...) { ... }` requires a non-empty selection); we discard the result because no caller needs confirmation. If a future caller wants the number for logging, change the return type at that point — non-breaking widening for current callers (none yet).

2. **Should the wrapper accept an opts object (`addBlockedBy({ blockedNodeId, blockerNodeId }, transport)`)?** No — the two-positional-args form is shorter and the role-mapping invariant is pinned by the test. An opts shape would buy nothing for two arguments and would make the role mapping unenforceable at the type level (both fields are `string`, swap-vulnerable just like positional). Recommendation: keep positional; revisit if a third argument appears.

3. **Should `GraphQLTransport` be re-imported here or redeclared?** Spec says re-import (single source of truth, sibling-module imports are fine inside `src/github/`). If a future ticket prefers to break the cross-module dependency (e.g. to keep `blocked-by.ts` independently testable without `project-client.ts`), redeclaring with the identical structural shape is a non-breaking change. Recommendation: import; promote to a shared `src/github/transport.ts` only when a third sibling appears.

4. **Should the mutation constant be a top-level `const`, an inline string, or a frozen template?** Spec says top-level `const ADD_BLOCKED_BY_MUTATION` — matches the `INIT_QUERY` / `ITEMS_QUERY` shape in `project-client.ts:47-50`. Inlining inside the function body would work too (the file is so small that legibility doesn't suffer); the top-level posture mirrors the precedent and groups all GraphQL strings at the top of the file.

5. **Should the test routing-table helper be extracted to `test/github/_helpers/transport.ts` now that two GraphQL test files exist?** Defer per the #19 § "Open question 5" rule — promote at the moment a *third* consumer appears (e.g. a future `removeBlockedBy.test.ts` or a `blocked-by-query.test.ts`). Two consumers is "duplicate the inline helper"; three is "extract." Same threshold the codebase has held to consistently.

## Out of scope (explicit non-goals)

- Wiring this primitive into the architect's split flow or any other consumer. Consumers land in their own tickets.
- Number→nodeId resolution. Callers compose with `src/github/issues.ts` (#35) before invoking this wrapper. Architectural decision (see § Context).
- `removeBlockedBy` mutation. No observed call site.
- A `blockedBy(issueNodeId)` query helper that fetches the current relationships. The dispatcher reads the native relationship via `hasOpenBlockers` (#6) over a `Blocker[]` shape supplied by the I/O layer; the fetch belongs in #20 (issues) or as a sibling primitive when the call site appears.
- Per-call cache, retry/backoff, rate-limit tracking. Same boundary as #19 — caching at the loop layer; resilience policy in the transport implementation.
- Adding `@octokit/graphql` to `package.json`. Happens when the launcher needs the production transport.
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" bullet explicitly forbids barrel re-exports inside `src/`.
- Promoting the test routing-table helper to `test/github/_helpers/transport.ts`. Defer until a third consumer appears.
- Seeding `docs/knowledge/architecture/system-overview.md`. Optional touchup; not required by AC.
