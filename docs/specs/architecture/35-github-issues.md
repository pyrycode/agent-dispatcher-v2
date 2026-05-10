# Spec: `src/github/issues.ts` — getIssue / createIssue / updateIssue (#35)

## Files to read first

- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — sets the file-size ceiling; this module targets ~95 production lines.
- `CLAUDE.md` § "Pure functions in `src/pipeline/`, I/O at the edges" — `src/github/` is the I/O edge; this module is allowed to `await` and to talk to the network (via the injected transport).
- `CLAUDE.md` § "Don't" — bullet "Don't import from a barrel file (`src/index.ts`) inside `src/`"; bullet "Don't write a defense for a failure mode that hasn't been observed" (caps the partial-update logic to exactly what the AC demands).
- `CLAUDE.md` § "Test-first" — RED → GREEN → REFACTOR is mandatory; `test/github/issues.test.ts` lands first.
- `src/github/project-client.ts:39-45` — `GraphQLTransport` declaration. This ticket establishes a parallel `RestTransport`; read the existing line to see the DI shape and comment style being mirrored.
- `src/github/project-client.ts:87-123` — static-factory + private-constructor pattern; `GitHubIssuesClient` mirrors it, minus the upfront ID resolution (REST endpoints take owner/repo/number directly).
- `src/config/env.ts:20-32` — `Config.githubOwner` and `Config.githubRepo` are the production sources for `{ owner, repo }`. This module does NOT read `Config` directly; the launcher will pass the values through `GitHubIssuesClient.create` (no `process.env` reads inside `src/github/`, per AC).
- `test/github/project-client.test.ts:8-32` — the routing-table mock pattern that this ticket's tests mirror. Same `RecordingTransport` / `makeTransport` shape, retyped to `RestTransport`.
- `test/github/project-client.test.ts:120-143` — verbatim error-propagation pattern (assert `caught instanceof Error` + canary substring). Reuse it for the "transport errors propagate" test.
- `docs/PROJECT-MEMORY.md` § "src/github/ I/O surface (#19)" — narrow-types convention, no try/catch fallback, no rate-limit / retry concerns. Same conventions apply here.
- `docs/specs/architecture/19-github-project-client.md` § "Why the transport is `(query, variables) => Promise<unknown>`" — the rationale for callable-shaped transports; the same reasoning applies to `RestTransport`'s `(method, path, body?)` shape.
- `biome.json:5-19` — formatter rules (double quotes, trailing commas all, semicolons, 100-col line width, 2-space indent). Any line over 100 cols breaks `pnpm lint`.

The ticket body lists five ACs and two implicit invariants ("no `process.env`", "no `src/index.ts` import"). Re-read those before sketching the test rows.

## Context

`#19` landed `GitHubProjectClient` for board-level reads (project items + Status field). This ticket lands the **issue-level** read/write surface — the second file in `src/github/`. Three thin wrappers (`getIssue`, `createIssue`, `updateIssue`) that the loop and rework flows will call without each caller hand-rolling its own transport.

Per CLAUDE.md "I/O at the edges": this module performs network I/O. It holds **zero business logic** — `decideLabelDelta` (#5) and the routing predicates (#7, #30, #31) decide what labels to write; this module writes them. A future caller passing `{ labels: ["wip:developer"] }` is responsible for that decision; `updateIssue` just translates the patch into a transport call.

Out of scope: every other GitHub helper (label mutations as standalone — covered indirectly via `updateIssue`'s `labels` patch; PR helpers; comment helpers; `blockedBy` queries; status-column mutations on the project board). Each lands in its own ticket.

## Design

### File: `src/github/issues.ts` (new, ~95 production lines)

#### Why a parallel `RestTransport` instead of reusing `GraphQLTransport`

The AC says tests "use the same DI'd transport mock as #19 (no real `gh` CLI invocations)." Read narrowly that mandates the literal `GraphQLTransport` type; read by intent it mandates the **same DI pattern** — hand-rolled function in tests, routing table style, no mock library. This spec takes the second reading and introduces a sibling `RestTransport` type. Three reasons drive that choice:

1. **Label semantics.** REST's `POST /repos/{o}/{r}/issues` takes `labels: string[]` (names) directly; the `PATCH /repos/{o}/{r}/issues/{n}` endpoint replaces the full label set in one call. GraphQL's `createIssue` mutation takes `labelIds: ID[]` (resolved node IDs), so a name-based caller would need an upfront `repository.labels(first: 100)` query plus a name→id map. That's a per-instance cache (or a per-call query). It works but doubles the module's surface area for a problem REST solves natively.
2. **Partial-update semantics.** GraphQL has no "set labels" mutation — only `addLabelsToLabelable` and `removeLabelsFromLabelable`. To honor the AC's "passing `{ labels }` updates only the labels" replace-semantics, GraphQL requires (a) `getIssue` to fetch current labels, (b) compute add/remove deltas, (c) two mutation calls. REST: one PATCH. For a "thin wrapper," one call is the right cost.
3. **Node-ID resolution.** GraphQL's `updateIssue` mutation keys on the issue's node ID, not its number. Number→nodeId requires either an extra query before every mutation or a cache. REST endpoints key on `(owner, repo, number)` directly.

The cost of the parallel transport is **one new exported type** (`RestTransport`) and **one new DI seam** for the launcher to wire. Both are paid once; they do not propagate. The launcher (a later ticket) wires both: `GraphQLTransport` for project-board GraphQL and `RestTransport` for issue REST. A reasonable `gh`-CLI-backed implementation of `RestTransport` is `(method, path, body) => exec("gh", ["api", "-X", method, path, ...flags(body)])`; an `@octokit/rest` implementation is equally one-line. Tests hand-roll either.

If a future ticket consolidates both behind a single `GhApiTransport` shape, that's a non-breaking refactor at the launcher seam — the modules' public APIs do not change.

#### Public surface

```ts
// src/github/issues.ts

/**
 * REST transport DI seam — parallel to GraphQLTransport in
 * project-client.ts. Production wiring will be a thin shell over
 * `gh api -X <method> <path>` or `@octokit/rest`'s callable. Tests
 * hand-roll a routing-table function — no mock library, no @octokit dep.
 *
 * Body is passed for POST/PATCH; GET passes undefined. Implementations
 * MUST JSON-encode the body and set Content-Type: application/json.
 * Implementations MUST throw / reject on non-2xx responses; the module
 * does not catch.
 */
export type RestTransport = (
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Narrow issue shape — only fields some downstream consumer reads.
 * Per the #6 narrow-types rule, do NOT widen for hypothetical future
 * consumers. If a future caller needs `assignees` / `milestone` /
 * `closedAt`, widen at that moment, not preemptively.
 */
export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;            // empty string when GitHub returns null
  readonly labels: readonly string[];
  readonly state: string;           // "open" | "closed" — kept as string to match the source contract
  readonly url: string;             // html_url (the user-facing URL, not api_url)
}

export interface CreateIssueInput {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface UpdateIssuePatch {
  readonly body?: string;
  readonly labels?: readonly string[];
}

export class GitHubIssuesClient {
  private constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly transport: RestTransport,
  ) {}

  /**
   * Synchronous factory — REST endpoints key on (owner, repo, number)
   * directly, so there is nothing to resolve up front (unlike #19's
   * GraphQL client, which had to cache project IDs). Static factory +
   * private constructor are kept for shape-symmetry with project-client
   * and so consumers can't accidentally construct an instance with a
   * wrong-shape transport.
   */
  static create(
    opts: { owner: string; repo: string },
    transport: RestTransport,
  ): GitHubIssuesClient;

  getIssue(number: number): Promise<Issue>;

  createIssue(input: CreateIssueInput): Promise<Issue>;

  /**
   * Partial update. Omitting both `body` and `labels` is a noop —
   * resolves to `null` without a transport call (AC #3). Passing only
   * `body` PATCHes only the body; passing only `labels` PATCHes only
   * the labels (REST replace-semantics: GitHub's PATCH replaces the
   * label set with what is sent).
   */
  updateIssue(number: number, patch: UpdateIssuePatch): Promise<Issue | null>;
}
```

The class has a private constructor; the only entry point is `GitHubIssuesClient.create(...)`. Per CLAUDE.md "no barrels inside `src/`," do not re-export any of these from `src/index.ts`.

Five exported names total: `RestTransport`, `Issue`, `CreateIssueInput`, `UpdateIssuePatch`, `GitHubIssuesClient`. At the cap, deliberately. If a future call site needs `IssueState = "open" | "closed"` extracted, that's the moment to widen, not now.

#### `getIssue(number)`

```
GET /repos/{owner}/{repo}/issues/{number}
```

Map the response to `Issue` via a private `mapIssue(raw: unknown)` helper. The helper narrows `unknown` defensively at the field level (each field is `typeof === "string"` / `"number"` checked before being trusted). Body's null → `""` substitution: GitHub returns `body: null` for issues created without one; the consumer expects a string.

No try/catch. The transport's rejection propagates.

#### `createIssue({ title, body, labels })`

```
POST /repos/{owner}/{repo}/issues
{ "title": ..., "body": ..., "labels": [...] }
```

Pass `labels` as `string[]` of names; GitHub's REST API takes names natively (no node-ID resolution). Map the response to `Issue`.

#### `updateIssue(number, patch)`

Build the body conditionally:

```ts
const body: Record<string, unknown> = {};
if (patch.body !== undefined) body.body = patch.body;
if (patch.labels !== undefined) body.labels = patch.labels;
if (Object.keys(body).length === 0) return null;
```

Then:

```
PATCH /repos/{owner}/{repo}/issues/{number}
<body built above>
```

Map the response to `Issue`. The early `return null` for empty patches satisfies AC #3 ("Omitting both is a noop, not an error") **without a transport call** — locked in by test #4 (assert `transport.calls.length === 0`).

REST's `PATCH` on `labels` is **replace-set semantics** (the array sent becomes the new full label set). This is the AC's intent. Documenting it inline is enough; the test scenarios pin the behavior.

`patch.body !== undefined` (not truthiness) is load-bearing — the caller can legitimately set `body: ""` (clear the body), and a `if (patch.body)` truthiness check would treat that as "not provided" and silently drop the update. Same shape rule for `labels` (caller can pass `[]` to clear all labels).

#### Header comment

Mirrors `project-client.ts:1-17`'s shape: intent + invariants + what's deferred. ~10 lines.

```
// REST wrappers for GitHub Issues — getIssue / createIssue / updateIssue.
// Thin transport over GitHub's /repos/{owner}/{repo}/issues endpoints; this
// module holds no business logic — decideLabelDelta (#5) and routing
// predicates (#7, #30, #31) decide what to write; this module writes it.
//
// Parallel to project-client.ts's GraphQLTransport: RestTransport is a
// callable DI seam (method, path, body?) => Promise<unknown>. The launcher
// wires both. Tests hand-roll a routing-table mock — no @octokit dep here.
//
// Out of scope: standalone label add/remove (use updateIssue's labels
// patch), comment / PR / blockedBy helpers, status-column mutations.
```

#### Why a class (instead of three free functions)

The ticket body's "exports `getIssue(number)`, `createIssue(...)`, `updateIssue(...)`" describes the public *parameter shapes* that callers see, not literally that the exports are top-level free functions. Three free functions would each need to take an `(owner, repo, transport)` triple, which (a) fans out the DI seam across every call site, (b) makes "ensure the same transport is reused" a caller-discipline concern, (c) diverges from #19's pattern.

The class binds `(owner, repo, transport)` once at `create` time. Callers see `client.getIssue(123)` — exactly the AC's `getIssue(number)` shape, with the context implicit. Symmetric with `GitHubProjectClient` in #19.

#### Concurrency model

None inside the class — async methods are independent. There is no shared mutable state (no caches, no rate-limit tracking — see "Out of scope"). Concurrent calls are safe and uncoordinated; the transport handles its own multiplexing.

#### Error handling

- **Transport rejections propagate verbatim.** No try/catch. Per AC #2 ("transport errors propagate (no silent swallowing)"). Test #5 locks this with a canary substring assertion (same shape as `project-client.test.ts` test #3).
- **Empty-patch `updateIssue` resolves to `null`.** Documented in the AC; no transport call is issued. Test #4 locks both the resolved value and `transport.calls.length === 0`.
- **No defensive `try/catch` around `mapIssue`.** If GitHub returns a malformed response, the field-level type guards in `mapIssue` reduce missing fields to safe defaults (empty string / empty array). A genuinely broken response would surface as a downstream bug; v2 has not observed one and CLAUDE.md says "Don't write a defense for a failure mode that hasn't been observed."

#### What does NOT land here (deferred per "Don't write a defense for a failure mode that hasn't been observed")

- **Standalone `addLabel(number, label)` / `removeLabel(number, label)` helpers.** Callers compose via `updateIssue`'s `labels` patch — the caller fetches current labels (via `getIssue`) and submits the new set. If a second call site emerges that needs delta-style add/remove without first reading the current set, promote at that point. v1's `addLabel`/`removeLabel` are not yet observed as load-bearing in v2.
- **Caching.** No issue cache, no label-set cache, no per-cycle dedup. Same rationale as #19: caching belongs at the loop boundary, not in this primitive.
- **Retry / backoff.** The transport handles its own resilience policy.
- **Rate-limit tracking.** Defer until budget pressure is observed.
- **`@octokit/rest` runtime dep.** The transport is interface-shaped; the launcher provides the implementation. `package.json` is **not** modified by this ticket.
- **Error-shape narrowing.** Transport throws `Error` (or a subtype); we don't classify by status code. If a future caller needs to distinguish "404 not found" from "401 unauthorized," widen at that moment.

### File: `test/github/issues.test.ts` (new, ~150 lines)

Mirrors the source path. Vitest, RED-first per CLAUDE.md. Mirrors `test/github/project-client.test.ts`'s routing-table pattern verbatim, retyped to `RestTransport`.

#### Test transport pattern

```ts
type Route = {
  match: (method: string, path: string, body: Record<string, unknown> | undefined) => boolean;
  respond: (
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
  ) => unknown | Promise<unknown>;
};

interface RecordingTransport {
  fn: RestTransport;
  calls: Array<{
    method: string;
    path: string;
    body: Record<string, unknown> | undefined;
  }>;
}

function makeTransport(routes: readonly Route[]): RecordingTransport {
  const calls: RecordingTransport["calls"] = [];
  const fn: RestTransport = async (method, path, body) => {
    calls.push({ method, path, body });
    for (const r of routes) {
      if (r.match(method, path, body)) return r.respond(method, path, body);
    }
    throw new Error(`No route matched: ${method} ${path}`);
  };
  return { fn, calls };
}
```

The `calls` log is the verification mechanism for "no transport call on empty patch" and "transport receives the right method/path/body."

#### Canned shape helper

```ts
function issueResponse(num: number, opts: Partial<{ title: string; body: string; labels: string[]; state: string }> = {}) {
  return {
    number: num,
    title: opts.title ?? `Issue ${num}`,
    body: opts.body ?? "",
    labels: (opts.labels ?? []).map((name) => ({ name })),  // GitHub returns labels as objects
    state: opts.state ?? "open",
    html_url: `https://example.test/${num}`,
  };
}
```

GitHub's REST API returns labels as `[{ name, color, description, ... }]` objects, not strings — `mapIssue` extracts `.name`. The test fixture must match the on-the-wire shape; otherwise the developer is testing against a strawman.

#### Test cases (each `it` covers one AC bullet)

1. **`getIssue` happy path (AC #1, #4 first bullet)**
   - Transport route: `method === "GET" && path === "/repos/pyrycode/agent-dispatcher-v2/issues/35"` → respond `issueResponse(35, { body: "Hello", labels: ["size:S", "ready:architect"] })`.
   - Assert: `await client.getIssue(35)` resolves to `{ number: 35, title: "Issue 35", body: "Hello", labels: ["size:S", "ready:architect"], state: "open", url: "https://example.test/35" }`.
   - Assert: `Object.keys(result).sort()` matches the narrow shape exactly (lock-in for "no extra GitHub fields leak through"; mirrors `project-client.test.ts` test #9).

2. **`createIssue` with labels (AC #1, #4 second bullet)**
   - Transport route: `method === "POST" && path === "/repos/pyrycode/agent-dispatcher-v2/issues"` → respond `issueResponse(99, { title: "New", body: "Body", labels: ["size:XS"] })`.
   - Call `client.createIssue({ title: "New", body: "Body", labels: ["size:XS"] })`.
   - Assert: result is the mapped `Issue`.
   - Assert: `transport.calls[0].body` deep-equals `{ title: "New", body: "Body", labels: ["size:XS"] }` — locks "labels are passed as `string[]`, not as `[{name}]`."

3. **`updateIssue` partial body (AC #3, #4 third bullet)**
   - Transport route: `method === "PATCH" && path === "/repos/pyrycode/agent-dispatcher-v2/issues/35"` → respond `issueResponse(35, { body: "Updated body" })`.
   - Call `client.updateIssue(35, { body: "Updated body" })`.
   - Assert: result's `body === "Updated body"`.
   - Assert: `transport.calls[0].body` deep-equals `{ body: "Updated body" }` — locks "labels key is absent from the body when not provided." A regression where `labels: undefined` leaks into the body would replace the issue's labels with an empty set on GitHub's side; this assertion is the canary.

4. **`updateIssue` partial labels (AC #3, #4 fourth bullet)**
   - Same route as test #3, respond `issueResponse(35, { labels: ["size:S"] })`.
   - Call `client.updateIssue(35, { labels: ["size:S"] })`.
   - Assert: result's `labels` deep-equals `["size:S"]`.
   - Assert: `transport.calls[0].body` deep-equals `{ labels: ["size:S"] }` — symmetric to test #3.

5. **`updateIssue` both fields (AC #3 "passing both updates both")**
   - Same route, respond `issueResponse(35, { body: "B", labels: ["L1", "L2"] })`.
   - Call `client.updateIssue(35, { body: "B", labels: ["L1", "L2"] })`.
   - Assert: `transport.calls[0].body` deep-equals `{ body: "B", labels: ["L1", "L2"] }`.

6. **`updateIssue` empty patch is a no-op (AC #3 "Omitting both is a noop, not an error")**
   - Transport: routes that throw if called (e.g. `match: () => true, respond: () => { throw new Error("should not be called"); }`).
   - Call `client.updateIssue(35, {})`.
   - Assert: result is `null`.
   - Assert: `transport.calls.length === 0`. **Both** assertions are load-bearing: "no error" alone could be satisfied by silently catching; "no transport call" alone could be satisfied by returning a fake `Issue`. Together they pin the contract.

7. **`updateIssue` with `body: ""` is NOT a no-op (defensive; locks the `!== undefined` semantics)**
   - Transport route: PATCH responds `issueResponse(35, { body: "" })`.
   - Call `client.updateIssue(35, { body: "" })`.
   - Assert: result is non-null; `transport.calls.length === 1`; `transport.calls[0].body` deep-equals `{ body: "" }`. Locks against a future "if (patch.body)" truthiness regression that would silently drop empty-string body updates.

8. **Transport errors propagate verbatim (AC #2)**
   - Transport route: any → throws `new Error("HTTP 401: Bad credentials")`.
   - Call `client.getIssue(35)`.
   - Assert: rejects; the error's `message` contains the canary substring `Bad credentials` (use exact-substring match, not a regex over the literal — same shape as `project-client.test.ts` test #3, "the error reaches the caller intact"). Repeat assertion for `createIssue` and `updateIssue` for symmetry — three small `it` blocks under one `describe`.

9. **Body's `null` from GitHub is mapped to `""` (defensive; matches the `Issue.body: string` contract)**
   - Transport returns `{ ...issueResponse(1), body: null }`.
   - Assert: `result.body === ""`. Locks the `Issue.body: string` (not `string | null`) contract.

10. **Labels deserialize from `[{name}]` to `string[]`**
    - Transport returns the canned shape (objects, per GitHub's wire format).
    - Assert: `result.labels` is `string[]` not `Array<{name: string}>`. Already covered indirectly by tests #1/#2/#4/#5; this is a focused single-assertion test for the mapping invariant.

Each `it` block is short (5–20 lines). Total test file: ~150 lines. No shared fixtures across tests — each builds its own routing table inline so a regression points at the exact failing scenario (same convention as `project-client.test.ts`).

### Implementation order (RED → GREEN, per AC)

1. Create `test/github/issues.test.ts` with all assertions, importing from `../../src/github/issues.ts`. Run `pnpm test` → fails (file does not exist yet). RED.
2. Create `src/github/issues.ts` with type definitions + class + methods + `mapIssue` helper. Run `pnpm test` → all cases pass. GREEN.
3. Run `pnpm typecheck && pnpm lint` → both pass.
4. Append `docs/knowledge/codebase/35.md` matching the precedent in `19.md` (exports, invariants encoded, design choices, test surface, files touched, out of scope).
5. Append a new "Patterns established" entry to `docs/PROJECT-MEMORY.md` under `### src/github/ issues REST surface (#35)` — the second `src/github/` ticket establishes the REST DI seam alongside the GraphQL one.
6. Commit (architect's spec is auto-committed by the safety net; the developer commits the code + doc updates as one).

If any step fails out of order (e.g. you write the source first), discard and restart. CLAUDE.md is explicit: "Backfilling tests after the fact ships bugs first."

### Concurrency model

None inside the class. Async methods are independent; no shared mutable state. Concurrent calls are safe and uncoordinated.

### Error handling

- Transport rejections propagate verbatim — no try/catch in the module.
- Empty `updateIssue` patch resolves to `null` without a transport call.
- `mapIssue` defensively narrows untrusted fields with field-level type guards (string / number checks) and substitutes safe defaults (`""` for null body, `[]` for missing labels). It does not throw on malformed input — same posture as `project-client.ts:152` (`mapItem`).

No try/catch around the transport. No "fail open." No silent fallback paths.

### Files touched

- `src/github/issues.ts` — new, ~95 lines (well under the 200-line hardcap).
- `test/github/issues.test.ts` — new, ~150 lines.
- `docs/PROJECT-MEMORY.md` — append a `### src/github/ issues REST surface (#35)` subsection.
- `docs/knowledge/codebase/35.md` — new per-ticket implementation summary.

No edits to existing source. No `src/index.ts` re-export. **No `package.json` change** — `@octokit/rest` is not added in this ticket; the transport interface is implementation-agnostic.

## Testing strategy

The 10 integration tests *are* the verification. There is no integration target against the real GitHub API; the hand-rolled `RestTransport` fake is the boundary, exactly as the AC requires ("no real `gh` CLI").

The three load-bearing test rows are:

- **#3 — partial-body PATCH body equals `{ body: "Updated body" }`.** Locks the "no `labels: undefined` leakage" contract. A regression where `labels` unconditionally serializes into the request body would silently replace the issue's labels with an empty set on GitHub.
- **#6 — empty patch makes zero transport calls AND resolves to `null`.** The two assertions together pin the AC's "noop, not an error" contract; either alone is forgeable.
- **#7 — `body: ""` IS a real update.** Locks the `!== undefined` semantics. A future "if (patch.body)" truthiness simplification would silently drop empty-body updates and break this test immediately.

CI gate: `pnpm typecheck && pnpm test && pnpm lint` (the four steps already wired up by #1).

## Open questions

1. **Should `Issue.state` be `"open" | "closed"` (closed union) or `string` (open)?** Spec says `string` to match `ProjectItem.status: string` from #19 (which uses a sentinel `"no-status"` for unknown values). GitHub's `state` is a closed enum on the API side, but downstream consumers in v2 don't currently branch on it — narrowing the type adds a refinement step at every call site for no observed benefit. If a future caller needs `IssueState`, extract then.

2. **Should `mapIssue` throw on a missing `number` field instead of silently producing a bogus `Issue`?** Spec says no — match `mapItem` in `project-client.ts:152` which returns `null` instead of throwing. Symmetry with the existing module is more important than defensive shouting; the transport rejecting on a non-2xx response is the deterministic boundary.

3. **Should the `RestTransport` shape support DELETE / PUT for future helpers (e.g. `deleteComment`, `setLabels`)?** No — narrow to what this ticket needs. Widening to all HTTP verbs is exactly the kind of "speculate on future consumers" that CLAUDE.md prohibits. When a future ticket needs DELETE, widen the union.

4. **Should the test routing-table helper be promoted to `test/github/_helpers/transport.ts` for sibling tickets to reuse?** Defer. #21 (labels/PR helpers) will land next; promote at the moment of the second consumer (same rule as `hasNeedsReworkLabel` in #6 and as called out in #19's spec). One copy in `test/github/project-client.test.ts` plus one new copy here is fine; the third copy is the trigger.

5. **Should `createIssue` accept an optional `assignees` field?** No — the AC enumerates `{ title, body, labels }`. Widening pre-emptively contradicts CLAUDE.md "narrow types until a consumer needs more."

6. **Should the path-builder use a helper (`issuePath(number) => /repos/${owner}/${repo}/issues/${number}`)?** Optional — three call sites is right at the threshold where a helper buys clarity over inlining. The developer's choice; either is defensible. If extracted, keep it private to the file.

## Out of scope (explicit non-goals)

- Wiring this client into the launcher (`src/dispatch-bin.ts`) or any loop. Consumers land in their own tickets.
- Standalone `addLabel` / `removeLabel` / `setLabels` helpers — callers compose via `updateIssue`'s `labels` patch.
- Comment helpers (`addComment`, `getComments`, `updateComment`).
- PR helpers (`getPR`, `mergePR`, `createPR`).
- `blockedBy` queries, status-column mutations on the project board, milestone / assignee mutations.
- Per-issue cache / per-cycle cache. Caching belongs at the loop boundary.
- Rate-limit tracking + per-cycle budget logging. Defer until budget pressure is observed.
- Retry / backoff. The transport handles its own resilience policy.
- Adding `@octokit/rest` to `package.json`. Happens when the launcher needs the production transport.
- Re-exporting from `src/index.ts`. CLAUDE.md "Don't" bullet explicitly forbids barrel re-exports inside `src/`.
- Promoting the test routing-table helper to `test/github/_helpers/transport.ts` — defer until the third consumer appears.
- Consolidating `RestTransport` and `GraphQLTransport` behind a unified `GhApiTransport`. Non-breaking refactor, defer until both have observable production wiring and a shared shape is obvious.
