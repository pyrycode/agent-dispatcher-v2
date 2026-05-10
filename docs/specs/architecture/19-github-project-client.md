# Spec: `src/github/project-client.ts` — org-aware Projects v2 client primitive (#19)

## Files to read first

- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — sets the file-size ceiling; this module is sized to land ~120–150 lines
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — explicitly names `src/github/` as the I/O edge; this module is allowed to `await` and to talk to the network (via the injected transport)
- `CLAUDE.md` § "Belt-and-suspenders" — the static `initialize` factory is the deterministic backstop that ensures cached IDs are resolved before any method runs (no `if (!projectId) throw "Not initialized"` defensive guard rotting in every method)
- `CLAUDE.md` § "Don't" — bullet "Don't import from a barrel file (`src/index.ts`) inside `src/`"; bullet "Don't write a defense for a failure mode that hasn't been observed" (constrains the per-cycle cache and rate-limit tracking — both deferred)
- `CLAUDE.md` § "Test-first" — RED → GREEN → REFACTOR is mandatory; the integration tests in `test/github/project-client.test.ts` go in first
- `src/config/env.ts:20-32` — the `Config` interface this client's launcher (later ticket) will read `githubOwner`, `projectNumber`, `ownerType`, `githubToken` from. `ownerType: "user" | "organization"` literal union is the exact shape consumed here.
- `src/pipeline/blockers.ts:9-19` — established narrow-input-types convention. `Blocker.state: string` (not the closed GraphQL enum) is the precedent for keeping POJO shapes minimal at the boundary; `ProjectItem` here mirrors it.
- `src/pipeline/blockers.ts:1-7` — header-comment style and "I/O lives in `src/github/`" framing for this directory; the new file's top-level comment uses the same shape (intent + invariants + what's deferred).
- `docs/PROJECT-MEMORY.md` § "src/pipeline/ purity (#6)" — codifies the narrow-input-types convention; the `ProjectItem` shape this ticket exports follows the same rule (only fields some downstream consumer reads)
- `docs/specs/architecture/6-pipeline-blockers.md` § "Files to read first" + § "Design" — layout precedent for this spec; this file follows the same headings
- `docs/specs/architecture/3-config-env.md` § "Why two functions" — establishes the "static factory + private constructor" pattern for ensuring an invariant ("project IDs resolved" here, "config validated" there) holds before any method runs
- `biome.json:5-19` — formatter rules biome enforces (double quotes, trailing commas all, semicolons always, 100-col line width, 2-space indent). Any line over 100 cols breaks `pnpm lint`.
- `package.json:11-21` — confirms `pnpm typecheck` / `pnpm test` / `pnpm lint` are the gates; `@octokit/graphql` is **not** currently a dep and this ticket does **not** add it (see § "Why no `@octokit/graphql` import here").
- `test/pipeline/blockers.test.ts:1-30` — Vitest import + describe/it style this file mirrors (`import { describe, expect, it } from "vitest"`, relative `../../src/...` import with `.ts` extension preserved)

The ticket body itself enumerates the four ACs and their two semantic invariants (org-aware dispatch is explicit; native ordering, never derived). Re-read those before writing the GraphQL queries — they translate one-to-one into the test rows.

## Context

This ticket lands the **single I/O initialization surface for `src/github/`**. Every other `src/github/*` module — `getIssue` helpers (#20), label / PR helpers (#21) — and the loop's state-fetch will share one initialization path. Two semantic invariants from the ticket body are load-bearing:

- **Org-aware dispatch is explicit.** GraphQL `user(login:)` and `organization(login:)` are distinct node lookups; the wrong one returns `null` (or an `errors[]` entry, depending on the API surface), not a fallback. The caller passes `ownerType: "user" | "organization"` and the client picks the right node lookup deterministically. **No try/catch fallback.** A try/`organization` then catch/`user` fallback masks legitimate auth errors as "wrong owner type" — a debugging trap v1 narrowly avoided.
- **Native ordering, never derived.** Board position is fetched via `ProjectV2ItemOrderField.POSITION`. Sorting client-side by `issueNumber` to approximate it would (a) put split-children out of order — PO inserts them at the top, lower issue numbers naturally, but the user's manual reorder would be invisible — and (b) silently break the dispatcher's "drag to prioritize" affordance.

The instance is dependency-injected into every other `src/github/*` module (and into the loop) so they don't reach for a global. Per CLAUDE.md "I/O at the edges," no file in `src/pipeline/` may import this module — pipeline functions take state in, return decisions out; this client supplies the state.

This ticket lands the **foundation only**: project resolution + Status field caching + items-in-board-order. `getIssue`, label mutations, PR helpers, and `blockedBy` queries are sibling tickets (#20, #21) that consume this client via DI.

Out of scope: any consumer (no wiring at the launcher; no loop integration; no per-cycle cache; no rate-limit tracking — see § "Out of scope" for the full list).

## Design

### File: `src/github/project-client.ts`

Single new file. Seeds the `src/github/` directory (no prior file). Estimated 120–150 production lines; well under the 200-line hardcap. One class + four small exports + two private GraphQL query strings.

#### Public surface

```ts
// src/github/project-client.ts

export type OwnerType = "user" | "organization";

/**
 * Narrow project-item shape exposed to consumers. Only fields some
 * downstream caller reads — per the #6 narrow-types rule, do NOT widen
 * for hypothetical future consumers (#20 / #21 / loop tickets will widen
 * when they need `body` / `blockedBy` / etc.).
 */
export interface ProjectItem {
  readonly id: string;             // Project item ID (used by future status-mutation tickets)
  readonly issueNumber: number;
  readonly title: string;
  readonly status: string;         // Column name, e.g. "Backlog", "In Architecture"
  readonly labels: readonly string[];
  readonly url: string;
}

export interface InitializeOpts {
  readonly owner: string;
  readonly project: number;        // GitHub Project (v2) number, from PROJECT_NUMBER
  readonly ownerType: OwnerType;
}

/**
 * DI shape for the GraphQL transport. Mirrors `@octokit/graphql`'s
 * exported callable shape so the production wiring (later ticket) is a
 * one-liner: `graphql.defaults({ headers: { authorization: \`token ${token}\` } })`.
 * Tests pass a hand-rolled function — no @octokit dep needed in this
 * module, no class hierarchy to mock.
 */
export type GraphQLTransport = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>;

export class GitHubProjectClient {
  /**
   * Resolve project ID + Status field ID + Status option IDs once,
   * return a fully-initialized instance. The constructor is private —
   * `initialize` is the only way to obtain a `GitHubProjectClient`,
   * which means every method can rely on the cached IDs without
   * defensive `if (!projectId) throw "Not initialized"` guards.
   */
  static initialize(
    opts: InitializeOpts,
    transport: GraphQLTransport,
  ): Promise<GitHubProjectClient>;

  /**
   * Fetch every project item in board (POSITION) order. Paginates via
   * `pageInfo.hasNextPage` + `endCursor`, capped at MAX_PAGES.
   */
  listItemsInBoardOrder(): Promise<readonly ProjectItem[]>;
}
```

The `GitHubProjectClient` constructor is **private**. Per CLAUDE.md "no barrels inside `src/`," do not re-export any of these from `src/index.ts`. Consumers (`src/github/issues.ts` in #20, `src/github/labels.ts` in #21, eventually `src/loop/`) import directly from `./github/project-client.ts`.

#### Why a static factory (not a public constructor + manual `.initialize()`)

The class invariant is "project ID + Status field ID + Status options resolved." A `new GitHubProjectClient(...)` followed by an awaited `.initialize()` (v1's pattern) lets callers forget — which is exactly why v1's `fetchAllItems` had to start with `if (!this.projectId) throw new Error("Not initialized")`. That guard rots in every method; `as` casts on transport responses get noisier; the failure mode is async-init-forgotten which is hard to spot in a code review.

A static factory that returns `Promise<GitHubProjectClient>` makes the invariant a type-system fact: you cannot get an instance without the IDs being resolved. Method bodies stay clean. Mirrors the `parseConfig` + `loadConfig` split in `src/config/env.ts` — the wrapper exists to make a precondition unfakable.

#### Why the transport is `(query, variables) => Promise<unknown>`

Mirrors `@octokit/graphql`'s exported callable shape (`graphql.defaults({...})` returns this exact signature). Three consequences:

1. **Production wiring is a one-liner** (later ticket): `const transport = graphql.defaults({ headers: { authorization: \`token ${cfg.githubToken}\` } });`
2. **Tests don't need a mock library.** Hand-roll a function that pattern-matches on the query string (or variables) and returns canned responses. The v1 `DispatchClient` interface family is the precedent — declare the surface, mocks satisfy it without `as any`.
3. **No `@octokit/graphql` import in this module.** Keeping the transport interface-shaped means this file is dep-free; the launcher (a later ticket) decides on the implementation. See § "Why no `@octokit/graphql` import here" below.

Why not a class with named methods (`transport.execute(...)`)? Two reasons: (a) every call site adds a method-name reference that buys nothing, (b) `@octokit/graphql`'s shape is already a callable — wrapping adds a layer to skip past in stack traces and test setup.

#### Owner-field selection — the no-fallback pattern

```ts
function ownerField(ownerType: OwnerType): "organization" | "user" {
  return ownerType === "organization" ? "organization" : "user";
}
```

Used to interpolate the right node lookup into the init query. **No try/catch around the GraphQL call.** A mismatched `ownerType` (e.g. an org account passed `ownerType: "user"`) returns a GraphQL error like `Could not resolve to a User with the login of 'pyrycode'` — that error is the truth of the input being wrong, and propagating it verbatim lets the operator fix the misconfiguration. A fallback (try org, catch, retry as user) would convert *every* GraphQL error — including auth failures, rate limits, and transient network issues — into "wrong owner type" advice, which is wrong and actively misleading.

This is also the reason the test's "mismatched ownerType propagates the GraphQL error verbatim" assertion checks the message text itself (canary string) rather than just `expect(...).toThrow()`. The contract is that the underlying error reaches the caller intact.

#### Initialization GraphQL query

Built once per `initialize` call, with `${ownerField}` interpolated into the literal:

```graphql
query($owner: String!, $number: Int!) {
  ${ownerField}(login: $owner) {
    projectV2(number: $number) {
      id
      fields(first: 30) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}
```

After the response:

1. Read `result[ownerField].projectV2.id` → cache as `projectId`.
2. Find `fields.nodes` whose `name === "Status"`. If absent, throw `Error("Status field not found on project")`. The thrown error names the field for operator clarity.
3. Cache `statusFieldId` from that field; build a `Map<string, string>` (column name → option id) from `options`.

The Status field resolution is upfront precisely so consumers don't re-query — the AC's "downstream callers don't re-query for every operation" is enforced by the IDs being instance fields, not method-call-derived.

#### Items-in-board-order GraphQL query

```graphql
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(
        first: 100,
        after: $cursor,
        orderBy: { field: POSITION, direction: ASC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            ... on Issue {
              number
              title
              url
              labels(first: 10) { nodes { name } }
            }
          }
        }
      }
    }
  }
}
```

`orderBy: { field: POSITION, direction: ASC }` is the load-bearing fragment — top of column first, matching the user's manual board ordering. Per AC, **never derive ordering** by sorting on `issueNumber` client-side. The test (§ "Testing strategy" #4) asserts items returned in scrambled-issue-number order are NOT re-sorted.

`first: 10` on `labels` matches v1; tickets in this codebase don't carry more than ~5 labels in practice.

`content { ... on Issue { ... } }` skips non-Issue content (PR fragments, DraftIssue). Nodes whose `content.number` is not a number are filtered out — same defensive filter v1 carries (the alternative is `undefined` `issueNumber` propagating into downstream code that keys on it).

#### Pagination

```ts
private static readonly MAX_PAGES = 50;
```

50 pages × 100 items = 5000 items. The dispatcher's projects are nowhere near this; the cap exists to surface a runaway loop (a future GraphQL bug echoing the same `endCursor`, or a malformed `pageInfo` that never flips `hasNextPage` to false) rather than silently consuming the GraphQL budget indefinitely. **Throw** when the cap is hit, with a message that suggests the cause:

```
fetchAllItems exceeded 50 pages — runaway pagination?
Aggregated <N> items so far. If the project is genuinely this large,
raise MAX_PAGES; otherwise check the endCursor logic for a loop.
```

Pagination IS a documented prior failure mode (v1's pre-2026-05-09 single `items(first: 100)` truncated boards past 100 entries — pyrycode #203). Land it in this ticket; don't defer.

#### What does NOT land here (deferred per "Don't write a defense for a failure mode that hasn't been observed")

- **Per-cycle items cache.** v1 carries one (`allItemsCache`) because the dispatcher loop calls `getItemsByStatus` ~14 times per cycle. v2's loop module doesn't exist yet; the cache concern conflates I/O with caching. When the loop lands and the cycle-cost shape is observable, layer the cache at that boundary (or wrap this client in a caching adapter). Do **not** pre-build it here.
- **Rate-limit tracking.** v1 logs `rateLimit { remaining resetAt cost }` on every fetch because budget pressure was observed. v2 hasn't observed it; defer until it is.
- **`getIssue`, label mutations, comment helpers, `blockedBy` queries, status mutations.** Sibling tickets (#20, #21).
- **Retry with exponential backoff.** v1's `fetchWithRetry` wraps `fetch`. The injected transport handles its own retry policy (`@octokit/graphql` ships none by default; the caller decides). This module is concerned with project semantics, not network resilience.
- **`@octokit/graphql` runtime dep.** See below.

#### Why no `@octokit/graphql` import here

The transport is an interface (`type GraphQLTransport`); the launcher provides the implementation. Two consequences:

- This module has zero runtime dependencies — only Node built-ins. Tests don't need `@octokit/graphql` either; the hand-rolled fake satisfies the same interface.
- `package.json` is **not** modified by this ticket. Adding `@octokit/graphql` happens when the launcher (a later ticket) needs to instantiate the production transport. Keeping the dep deferral in this ticket means: (a) the integration tests are zero-dep + zero-network, (b) a developer who wants to swap the transport (e.g. to a `gh api graphql --jq` shell-out for a constrained environment) doesn't have to rip out an import.

If a future ticket prefers to ship a default transport from this module, that's a non-breaking addition (export an extra `defaultTransport(token: string): GraphQLTransport` helper). Don't do it now.

### Concurrency model

None inside the class — async methods are independent. Each `listItemsInBoardOrder()` call issues its own GraphQL fetch sequence; concurrent calls are safe and uncoordinated (no shared mutable state beyond the cached IDs, which are read-only after `initialize`).

If a caller wants to dedupe concurrent `listItemsInBoardOrder()` calls, that's a wrapper concern (loop module). This client doesn't pre-empt the decision.

### Error handling

- `initialize` throws `Error("Status field not found on project")` if the Status field is absent.
- `initialize` propagates GraphQL errors from the transport **verbatim** — no try/catch, no fallback, no message rewriting. The "wrong `ownerType`" failure mode is exactly this.
- `listItemsInBoardOrder` throws on pagination cap exceeded (message above).
- `listItemsInBoardOrder` propagates GraphQL errors from the transport verbatim.
- The transport itself can throw or reject; we do not catch. The contract is "transport semantics are the caller's choice."

No try/catch inside this module. No "fail open." No silent fallback paths.

### File: `test/github/project-client.test.ts`

Mirrors the source path. Vitest, RED-first per CLAUDE.md. Seeds the `test/github/` directory (no prior file). Estimated ~150–200 lines for ~10 cases.

#### Test transport pattern

A hand-rolled `GraphQLTransport` factory that takes a routing table from query-substring to canned response (or thrown error):

```ts
type Route = { match: (query: string, variables: Record<string, unknown>) => boolean; respond: (variables: Record<string, unknown>) => unknown | Promise<unknown> };

function makeTransport(routes: Route[]): GraphQLTransport & {
  calls: Array<{ query: string; variables: Record<string, unknown> }>;
} {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const transport: GraphQLTransport = async (query, variables) => {
    calls.push({ query, variables });
    for (const r of routes) {
      if (r.match(query, variables)) return r.respond(variables);
    }
    throw new Error(`No route matched query: ${query.slice(0, 80)}...`);
  };
  // Attach calls log for assertion use.
  return Object.assign(transport, { calls });
}
```

Routing on substring keeps the test readable (`q.includes("organization(")` for org-init, `q.includes("orderBy:")` for items, etc.). Tests can swap responses per scenario without inheriting cross-test setup.

The `calls` log is the verification mechanism for "transport receives the correct ownerField" — assert that the org-init test never produces a query with `user(login:` and vice versa.

#### Test groups (each `describe` maps to one or more AC bullets)

1. **`initialize` — org init succeeds (AC #1, #2)**
   - Transport routes: `organization(login:` → returns canned `{ organization: { projectV2: { id: "PVT_x", fields: { nodes: [{id: "FIELD_x", name: "Status", options: [{id: "OPT_BACKLOG", name: "Backlog"}, ...]}] } } } }`.
   - Assert: `await GitHubProjectClient.initialize({ owner: "pyrycode", project: 7, ownerType: "organization" }, transport)` resolves; the returned instance is usable (smoke-call `listItemsInBoardOrder` with an empty-page transport response).
   - Assert: `transport.calls[0].query.includes("organization(")` is `true`; `transport.calls[0].query.includes("user(")` is `false`.

2. **`initialize` — user init succeeds (AC #1, #2)**
   - Same as above with `ownerType: "user"`, transport routes `user(login:` → analogous response shape.
   - Assert: query contains `user(` and not `organization(`.

3. **Mismatched `ownerType` propagates GraphQL error verbatim (AC #2)**
   - Transport routes any query → throws `new Error("Could not resolve to a User with the login of 'pyrycode'")`.
   - Caller passes `ownerType: "user"`.
   - Assert: `await initialize(...)` rejects; the thrown error's `message` contains the canary substring `Could not resolve to a User`. Use exact-substring match (not a `toThrow` regex over the literal) so the contract is "the error reaches the caller intact."
   - Assert: there is no second transport call (no fallback retry as `organization`).

4. **Items returned in POSITION order regardless of issue-number (AC #3)**
   - Init transport route returns a valid project + Status field.
   - Items transport route returns canned items in deliberately scrambled issue-number order: e.g. nodes for issues 50, 10, 30, 20 — in that order in the response.
   - Assert: `await client.listItemsInBoardOrder()` returns items in issue-number order `[50, 10, 30, 20]` (the order the transport gave, i.e. POSITION).
   - Regression-guard assertion: explicitly `expect(items.map(i => i.issueNumber)).not.toEqual([10, 20, 30, 50])` — locks in "no client-side sort by issueNumber."

5. **`listItemsInBoardOrder` paginates** (lock-in for the v1 #203 fix)
   - Transport route: page 1 returns `pageInfo: { hasNextPage: true, endCursor: "C1" }` with nodes for issues 1–100; page 2 returns `pageInfo: { hasNextPage: false, endCursor: null }` with nodes for issues 101–105.
   - Assert: returned array is 105 items, in the order received across both pages.
   - Assert: `transport.calls` includes two items queries; the second's `variables.cursor === "C1"`.

6. **Pagination cap throws after `MAX_PAGES`** (regression guard for runaway loop)
   - Transport route: every items query returns `pageInfo: { hasNextPage: true, endCursor: "always" }`.
   - Assert: `await client.listItemsInBoardOrder()` rejects with a message matching `/exceeded \d+ pages/`.

7. **Non-Issue content nodes are skipped**
   - Transport returns mixed nodes: one with `content: { number: 1, title: "...", url: "...", labels: { nodes: [] } }`, one with `content: {}` (no `number` — simulates a PR fragment or DraftIssue).
   - Assert: result has length 1; only the Issue is included.

8. **`initialize` throws if Status field is missing**
   - Transport route returns valid project but `fields.nodes` has no entry with `name === "Status"`.
   - Assert: `initialize` rejects with `/Status field not found/`.

9. **Items map to `ProjectItem` shape** (structural — keeps the narrow-shape contract honest)
   - Transport returns one item with all fields populated.
   - Assert: result item has exactly the expected keys (`id`, `issueNumber`, `title`, `status`, `labels`, `url`); no extra keys leaked from the GraphQL response (no `body`, no `blockedBy`, no `fieldValueByName`).

10. **`status` defaults to a non-empty placeholder when `fieldValueByName` is null** (defensive — matches v1 behavior)
    - Transport returns one item with `fieldValueByName: null`.
    - Assert: `status` is `"no-status"` (matches v1's idiom; alternative is to throw, but v1's chose-not-to-throw posture lets boards with un-statused items still be listed). If the developer prefers `null` here over a sentinel string, that's a defensible alternative — flag in the PR description and pick one. Recommendation: keep the sentinel string so `ProjectItem.status: string` (not `string | null`), which keeps consumer types simpler.

Each `it` block is short (5–20 lines). Total test file: ~150–200 lines. No shared fixtures across tests; each test builds its own routing table inline so a regression points at the exact failing scenario.

### Implementation order (RED → GREEN, per AC)

1. `mkdir -p src/github test/github` (no `.gitkeep` — both files land immediately).
2. Create `test/github/project-client.test.ts` with all assertions, importing from `../../src/github/project-client.ts`. Run `pnpm test` → fails (file does not exist yet). RED.
3. Create `src/github/project-client.ts` with type definitions + class + queries + pagination logic. Run `pnpm test` → all cases pass. GREEN.
4. Run `pnpm typecheck && pnpm lint` → both pass.
5. Append `docs/knowledge/codebase/19.md` matching the precedent in `1.md` / `3.md` / `6.md` / `24.md`. Append a new "Patterns established" entry to `docs/PROJECT-MEMORY.md` under `### src/github/ I/O surface (#19)` — the first `src/github/` ticket establishes the directory's conventions (transport DI, static factory, narrow `ProjectItem`, no per-cycle cache).
6. Optionally seed `docs/knowledge/architecture/system-overview.md` (PROJECT-MEMORY notes this should land with the first `src/` ticket; #2 deferred it; #19 is the natural moment because it introduces the I/O boundary that the system-overview will describe). If seeding feels out of scope, defer to a follow-up — the spec doesn't require it.
7. Commit (architect's auto-commit safety net catches the spec; the developer commits the code + doc updates).

If any step fails out of order (e.g. you write the source first), discard and restart. CLAUDE.md is explicit: "Backfilling tests after the fact ships bugs first."

### Files touched

- `src/github/project-client.ts` — new, ~120–150 lines
- `test/github/project-client.test.ts` — new, ~150–200 lines
- `docs/PROJECT-MEMORY.md` — append a `### src/github/ I/O surface (#19)` subsection
- `docs/knowledge/codebase/19.md` — new per-ticket implementation summary
- (optional) `docs/knowledge/architecture/system-overview.md` — first seed; not required by AC

No edits to existing source. No `src/index.ts` re-export. **No `package.json` change** — `@octokit/graphql` is not added in this ticket; the transport interface is implementation-agnostic.

## Testing strategy

The ten integration tests *are* the verification. There is no integration target against the real GitHub API; the hand-rolled `GraphQLTransport` fake is the boundary, exactly as the AC requires ("no real `gh` CLI").

The two load-bearing test rows are:

- **#3 — mismatched `ownerType` propagates verbatim.** This locks the no-fallback contract. A future PR that wraps the GraphQL call in `try { /* org */ } catch { /* fallback to user */ }` will break this test by either (a) succeeding in the user-fallback branch when the org should have errored, or (b) producing two transport calls instead of one. Both are caught.
- **#4 — POSITION ordering, not derived from `issueNumber`.** Locks the native-ordering contract. A future "let's just sort items by issueNumber for stable test ordering" simplification would break the explicit `not.toEqual([10, 20, 30, 50])` assertion immediately, with a failure pointing at exactly the right line.

CI gate: `pnpm typecheck && pnpm test && pnpm lint` (the four steps already wired up by #1).

## Open questions

1. **Should `status` be `string` (with `"no-status"` sentinel) or `string | null`?** Spec recommends sentinel string for consumer ergonomics — every downstream call site treats `status` as a column name; `null` forces a narrow at every read site. v1 uses the sentinel. If the developer prefers `null`, change the type and update test #10. Either choice is defensible; pick one and document.

2. **Should `ProjectItem.labels` be a `readonly string[]` or a `ReadonlySet<string>`?** Spec says `readonly string[]` to match the v1 shape and the established pattern in `BranchState.labels` (`src/pipeline/blockers.ts:18`). Set lookup is O(1) but consumers want order preserved (board display); array preserves it.

3. **Should the `MAX_PAGES = 50` constant be configurable (constructor opt)?** No — fixed for now. v1's value has held; making it tunable adds API surface for an unobserved need. Revisit if a consumer (large-board adopter) actually hits it.

4. **Should `initialize` log success (`console.log(\`Initialized: project=${id}\`)` like v1)?** No. This module is a primitive; the launcher decides what to print. Logging from a library is a CLAUDE.md "loop/launcher decides" boundary.

5. **Should the test pattern (routing table → canned response) be extracted into `test/github/_helpers/transport.ts` for sibling tickets to reuse?** Defer. #20 / #21 will land next; promote the helper at the moment a second consumer appears (same rule as `hasNeedsReworkLabel` in #6 — don't extract until two call sites exist).

## Out of scope (explicit non-goals)

- Wiring this client into the launcher (`src/dispatch-bin.ts`) or any loop. Consumers land in their own tickets.
- `getIssue` / `addLabel` / `removeLabel` / `addComment` / `getIssueLabels` / `updateItemStatus` / `blockedBy` queries — sibling tickets (#20, #21).
- Per-cycle items cache. v1 carries one for valid reasons; v2's caching layer belongs at the loop boundary, not in this primitive.
- Rate-limit tracking + per-cycle budget logging. Defer until budget pressure is observed.
- Retry / backoff. The transport handles its own resilience policy; this module is concerned with project semantics.
- Adding `@octokit/graphql` to `package.json`. Happens when the launcher needs the production transport.
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" bullet explicitly forbids barrel re-exports inside `src/`.
- Seeding `docs/knowledge/architecture/system-overview.md` — optional touchup mentioned in step 6; not required by this ticket's ACs.
- `wip:*` / `error:*` lifecycle handling, label transitions, blocker resolution. All upstream/downstream concerns; this client just exposes the raw board state.
