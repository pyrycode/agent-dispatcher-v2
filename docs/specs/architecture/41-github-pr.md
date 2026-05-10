# Architecture spec — #41 `src/github/pr.ts`

Three thin PR-surface I/O ops — `createPr`, `enableAutoMerge`, `mergePr` —
that the dispatcher's loop and salvage flows go through. This module makes
no decisions; it executes them. The one non-trivial bit is `mergePr`'s
**conflict-as-typed-value** return shape: a transport-level merge conflict
surfaces as `{ merged: false, reason: "conflict" }` rather than a thrown
`Error`, so the loop can roll project status back from Done → In Code Review
without the call site catching strings.

## Files to read first

The developer's turn-1 reading list. Each entry has a one-line "what to extract."

- `src/github/project-client.ts:42-45` — `GraphQLTransport` callable type. **Re-use this verbatim** by `import type { GraphQLTransport } from "./project-client.ts"`. Same posture #37 took for `addBlockedBy`.
- `src/github/project-client.ts:87-123` — async-factory + private-ctor pattern. **Mirror this shape** for `GitHubPrClient.initialize({owner, repo}, transport)` — one preflight query resolves the repository node ID once, methods then rely on it without defensive guards.
- `src/github/project-client.ts:47-50` — minified single-line GraphQL `const`s at the top of the file. Mirror this layout — keeps the 200-line hardcap reachable.
- `src/github/blocked-by.ts:24-38` — minimal mutation primitive shape (single GraphQL string + single async fn). The transport-error-propagates-verbatim posture is **inverted** in this ticket for `mergePr` only — see § Error handling.
- `test/github/blocked-by.test.ts:8-33` — `makeTransport(routes)` recording-transport mock. **Reuse this shape verbatim** — copy the helper into `test/github/pr.test.ts`. Per the #37 spec, do NOT extract to a shared `test/github/_helpers/transport.ts` until a third GraphQL consumer appears (this is the third — but #37 didn't extract, so the test directory keeps its inline copy convention; one more inline is the cheaper-to-revert default).
- `test/github/blocked-by.test.ts:36-75` — the role-mapping deep-equals + `transport.calls.length === 1` lock-in pattern. **Reuse this shape** for `createPr`'s body-shape pin and `enableAutoMerge`'s variables-shape pin.
- `docs/PROJECT-MEMORY.md` § "src/github/ I/O surface (#19)" — every bullet applies (DI seam, factory shape, narrow `ProjectItem`, no `@octokit/graphql` dep, queries are minified single-line strings). The `MAX_PAGES = 50` runaway-pagination cap is the precedent for the conflict-detection deterministic guard in this ticket.
- `docs/PROJECT-MEMORY.md` § "src/github/ blocked-by primitive (#37)" — the "no try/catch, no fallback retry, no message rewriting" stance. **`mergePr` deliberately deviates** for the conflict-classification path; the deviation is justified inline in this spec and surfaces as a single `try/catch` block with one substring match. No other method in the file has a `try/catch`.
- `docs/lessons.md` § "GitHub REST" — for shape parity, `createPr`'s body-construction discipline ("conditional body assembly, deep-equals assertion in tests") generalizes from PATCH replace-set to the optional-`draft` field here.
- `CLAUDE.md` § "One concern per file, hardcap 200 lines" — expected actual: **80–110 lines** including header. This spec's `mergePr` typing pushes the file higher than #37's 38 lines but well under the cap.

## Context

**Why now.** Two consumers want this surface:

1. **Loop's `runAutoMerge`.** The v1 lesson `baba720` (2026-05-09 evening) documented the failure mode: `runAutoAdvance` moved a ticket to Status=Done as soon as `ready:documentation` landed; auto-merge then attempted `gh pr merge`, which **failed on conflict**; without a typed value the dispatcher swallowed the merge failure and treated the ticket as Done forever, while the PR sat unmerged. The fix surfaces conflict explicitly so the caller can roll Status back from Done → In Code Review and label the PR `error:merge-conflict` for human triage.
2. **Salvage flow (#12, future ticket).** When a developer/code-review run hits `max_turns`, salvage applies `error:max_turns_salvaged` (#36's `addLabel`-throws semantic backstops this) BEFORE creating a draft PR. The salvage flow needs `createPr({ ..., draft: true })` over the same transport seam.

Both consumers want one module so the launcher wires one DI seam (the GraphQL transport) once.

**What this is not.** This module:

- Does NOT decide whether to merge. The pure pipeline (`findReadyPrNumber`, sibling ticket — see ticket body's Technical Notes) decides; this module executes.
- Does NOT roll back project status. The loop layer composes `mergePr`'s typed result with `GitHubProjectClient`'s status-mutation primitive (separate ticket). This module returns the value; the caller acts on it.
- Does NOT retry across cycles. The cross-cycle `merge-attempt:N` retry counter is the loop layer's concern (v1 lesson 2026-05-10 evening, `agent-dispatcher@aa588bf`); this module's `mergePr` is **per-call** — one shot, typed result, no internal retry, no internal cycle counter.

## Design

### Module shape

```ts
// src/github/pr.ts

import type { GraphQLTransport } from "./project-client.ts";

export interface PrInfo {
  readonly number: number;
  readonly nodeId: string;
  readonly url: string;
}

export interface CreatePrInput {
  readonly title: string;
  readonly body: string;
  readonly head: string;       // branch name, e.g. "feature/41"
  readonly base: string;       // target branch, e.g. "main"
  readonly draft?: boolean;    // defaults to false
}

export type MergeResult =
  | { readonly merged: true }
  | { readonly merged: false; readonly reason: "conflict" | "other"; readonly error: Error };

export class GitHubPrClient {
  private constructor(
    private readonly transport: GraphQLTransport,
    private readonly repositoryId: string,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  static async initialize(
    opts: { owner: string; repo: string },
    transport: GraphQLTransport,
  ): Promise<GitHubPrClient>;

  async createPr(input: CreatePrInput): Promise<PrInfo>;
  async enableAutoMerge(prNumber: number): Promise<void>;
  async mergePr(prNumber: number): Promise<MergeResult>;
}
```

### Why GraphQL throughout (not REST + GraphQL hybrid)

Three constraints make GraphQL the right single transport:

- **`enablePullRequestAutoMerge` is GraphQL-only.** GitHub does not expose a REST endpoint for auto-merge enable. Whatever transport this method uses dictates the seam for the rest by parity.
- **PR node IDs are returned natively from `createPullRequest`.** REST `POST /pulls` returns `node_id` too, but stitching the rest of the file's calls (`enablePullRequestAutoMerge`, `mergePullRequest`) to a REST createPr would mean storing a REST transport AND a GraphQL transport on the client, doubling the DI surface. The v1 lesson is "two transports complicate the launcher and the test mocks for marginal call-site simplicity gains." One transport, one mock, one DI wire.
- **#19's factory pattern fits cleanly.** `GitHubProjectClient.initialize` resolves project + status field IDs once and caches them; `GitHubPrClient.initialize` resolves the repository node ID the same way. The async factory is the seam where preflight queries belong.

### `initialize` — preflight resolves `repositoryId`

```ts
const REPO_ID_QUERY =
  "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}";

static async initialize(
  opts: { owner: string; repo: string },
  transport: GraphQLTransport,
): Promise<GitHubPrClient> {
  const result = (await transport(REPO_ID_QUERY, {
    owner: opts.owner,
    name: opts.repo,
  })) as { repository: { id: string } | null };
  if (!result.repository) {
    throw new Error(`Repository not found: ${opts.owner}/${opts.repo}`);
  }
  return new GitHubPrClient(transport, result.repository.id, opts.owner, opts.repo);
}
```

Same shape as `GitHubProjectClient.initialize`'s "Project not found" throw (`project-client.ts:111-113`). The preflight is the unfakable precondition — methods that need `repositoryId` can rely on it without runtime guards.

`owner` and `repo` are stored alongside `repositoryId` because the PR-by-number queries in `enableAutoMerge` / `mergePr` traverse via `repository(owner:$o,name:$r){pullRequest(number:N){id ...}}` — GraphQL has no "PR by number-only" entry point that doesn't go through the repo. Storing the trio is one ctor parameter; the alternative (re-passing them at every call) is API noise.

### `createPr` — single mutation, body-shape pinned

```ts
const CREATE_PR_MUTATION =
  "mutation($repositoryId:ID!,$title:String!,$body:String!,$baseRefName:String!,$headRefName:String!,$draft:Boolean!){createPullRequest(input:{repositoryId:$repositoryId,title:$title,body:$body,baseRefName:$baseRefName,headRefName:$headRefName,draft:$draft}){pullRequest{id number url}}}";

async createPr(input: CreatePrInput): Promise<PrInfo> {
  const result = (await this.transport(CREATE_PR_MUTATION, {
    repositoryId: this.repositoryId,
    title: input.title,
    body: input.body,
    baseRefName: input.base,
    headRefName: input.head,
    draft: input.draft ?? false,
  })) as { createPullRequest: { pullRequest: { id: string; number: number; url: string } } };
  const pr = result.createPullRequest.pullRequest;
  return { number: pr.number, nodeId: pr.id, url: pr.url };
}
```

**`draft` defaults to `false` via `?? false`.** Pinned by the `draft: true` test asserting `variables.draft === true` AND the non-draft test asserting `variables.draft === false`. The deep-equals on `t.calls[0]?.variables` is the body-shape canary — same role as #36's body-shape pins for the labels endpoint.

**Why `draft` is required in the variables (`Boolean!`, not `Boolean`).** The mutation always sends a literal `true` or `false`. If the variable is optional and the call omits it, GitHub's GraphQL silently defaults to `false` — same end state, but the test mock has to match a wire shape that omits the key vs sends `false`, which is fragile. Required-with-explicit-default makes the wire shape predictable and the test mock straightforward.

**Errors propagate verbatim.** Per #19/#37 posture — invalid base/head ref, branch-not-found, unauthorized, rate-limit all surface as the canonical GraphQL error. No try/catch, no fallback retry. The salvage flow's "addLabel before createPr" ordering depends on createPr throwing visibly on failure; swallowing here would mirror the labels-flow regression #36 specifically guards against.

### `enableAutoMerge` — number → nodeId resolution + mutation

```ts
const PR_ID_BY_NUMBER_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id}}}";

const ENABLE_AUTO_MERGE_MUTATION =
  "mutation($pullRequestId:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId}){pullRequest{number}}}";

async enableAutoMerge(prNumber: number): Promise<void> {
  const nodeId = await this.resolvePrNodeId(prNumber);
  await this.transport(ENABLE_AUTO_MERGE_MUTATION, { pullRequestId: nodeId });
}
```

The two-call shape (resolve number → nodeId, then mutate) is the cost of the AC's number-keyed signature. Caching `(number → nodeId)` would speculate on a hypothetical caller-keeps-calling pattern; the loop calls each PR's enableAutoMerge once. Two calls per enable is acceptable.

**`Promise<void>` return.** The mutation's `pullRequest{number}` selection is the GraphQL-required non-empty selection set (same shape as #37's `addBlockedBy`); the response is intentionally discarded. Absence of a thrown error IS the success signal. Errors propagate verbatim — no conflict typing here, because enabling auto-merge succeeds even when the PR is currently conflicting (GitHub queues the merge for later). Conflict is `mergePr`'s concern.

### `mergePr` — the typed-result method

```ts
const MERGE_PR_MUTATION =
  "mutation($pullRequestId:ID!){mergePullRequest(input:{pullRequestId:$pullRequestId}){pullRequest{number merged}}}";

async mergePr(prNumber: number): Promise<MergeResult> {
  const nodeId = await this.resolvePrNodeId(prNumber);
  try {
    await this.transport(MERGE_PR_MUTATION, { pullRequestId: nodeId });
    return { merged: true };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { merged: false, reason: classifyMergeError(error), error };
  }
}

function classifyMergeError(error: Error): "conflict" | "other" {
  const msg = error.message.toLowerCase();
  if (msg.includes("not mergeable") || msg.includes("merge conflict") || msg.includes("conflict")) {
    return "conflict";
  }
  return "other";
}
```

**This is the one place the file deviates from the #37 "errors propagate verbatim" stance.** The deviation is the entire reason this ticket exists: the loop needs a typed value to roll status back, not a string to match in a catch block. Catching at the wrapper boundary (vs at the call site) means the substring-classification rule lives in one well-tested place, not duplicated across every consumer.

**Why substring-match over a pre-flight `mergeable` query.** A pre-flight `pullRequest(number:N){mergeable}` adds one round-trip on every successful merge — the dispatcher merges every successful ticket, so this is the hot path. Substring-match on the error message keeps the happy path at one network call. The trade-off is fragility against GitHub error-message wording drift; the regression guard is **the test pinning the substring** (a future GitHub message change breaks a test in CI, not in production).

**Substring set is conservative.** `"not mergeable"` is the canonical GraphQL message for `mergePullRequest` against a CONFLICTING PR. `"merge conflict"` and bare `"conflict"` are belt-and-suspenders against minor wording variations (e.g., "this branch has conflicts that must be resolved" — observed in some REST contexts and worth covering in case GraphQL drifts toward parity). The lowercase match is intentional — GitHub mixes casing across endpoints.

**Pre-flight resolution `resolvePrNodeId` is NOT inside the try/catch.** A "PR not found" error during resolution must NOT be misclassified as a merge conflict — it's a genuine `other` (or arguably should throw). Resolution errors propagate verbatim before the try/catch begins. Test #5 pins this: an unknown PR number throws, NOT returns `{merged: false, reason: 'other'}`. The try/catch wraps **only the mutation**, not the resolution.

Wait — that's a contract decision. The AC says "`mergePr` returns `{ merged: false, reason: 'conflict' | 'other', error }` on failure." Strict reading: ALL failures, including resolution failures, return a typed value. The looser reading: the typed result is for the merge attempt itself; pre-flight errors throw. **Go with the strict reading** — it matches the AC literally, and the loop layer is simpler when one method has one return contract. So the try/catch wraps the entire body:

```ts
async mergePr(prNumber: number): Promise<MergeResult> {
  try {
    const nodeId = await this.resolvePrNodeId(prNumber);
    await this.transport(MERGE_PR_MUTATION, { pullRequestId: nodeId });
    return { merged: true };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { merged: false, reason: classifyMergeError(error), error };
  }
}
```

A resolution failure surfaces as `{merged: false, reason: 'other', error}` (the "PR not found" message won't match the conflict substrings). Caller handles `other` by alerting or retrying-next-cycle; same code path as a transport timeout. Simpler than two contracts.

### `resolvePrNodeId` — private helper

```ts
private async resolvePrNodeId(prNumber: number): Promise<string> {
  const result = (await this.transport(PR_ID_BY_NUMBER_QUERY, {
    owner: this.owner,
    name: this.repo,
    number: prNumber,
  })) as { repository: { pullRequest: { id: string } | null } | null };
  const id = result.repository?.pullRequest?.id;
  if (!id) {
    throw new Error(`Pull request not found: ${this.owner}/${this.repo}#${prNumber}`);
  }
  return id;
}
```

Private — only `enableAutoMerge` and `mergePr` need it. Same defensive throw-on-null shape as `initialize`'s "Repository not found." The thrown error from `mergePr`'s call site is caught and typed; the thrown error from `enableAutoMerge`'s call site propagates per the verbatim-errors rule.

## Concurrency model

Single-threaded per call. No goroutines, no workers, no shared state across calls beyond the cached `repositoryId` (immutable post-`initialize`). The dispatcher's loop is single-threaded per ticket; concurrent calls on the same PR aren't a contract this module owns.

## Error handling

| Method | Path | Posture |
|---|---|---|
| `initialize` | "Repository not found" | Throw — same as #19 |
| `createPr` | Any GraphQL error | Throw — verbatim, no rewriting |
| `enableAutoMerge` | Resolve fails | Throw — verbatim |
| `enableAutoMerge` | Mutation fails | Throw — verbatim |
| `mergePr` | Resolve fails | Catch → `{merged:false, reason:'other', error}` |
| `mergePr` | Mutation fails (conflict) | Catch → `{merged:false, reason:'conflict', error}` |
| `mergePr` | Mutation fails (other) | Catch → `{merged:false, reason:'other', error}` |
| `mergePr` | Mutation succeeds | `{merged:true}` |

`mergePr` is the only method with a try/catch. All other methods follow the file-wide "errors propagate verbatim" stance from #19/#37. The asymmetry is deliberate; the test suite pins it (test #2 — `createPr` throws on transport failure; test #4 — `mergePr` does NOT throw on transport failure).

## Testing strategy

File: `test/github/pr.test.ts`. Reuse `makeTransport(routes)` verbatim from `test/github/blocked-by.test.ts:8-33` (or `test/github/project-client.test.ts:8-32`). Per the #37 spec, do NOT extract to a shared helper; one more inline copy is the cheaper-to-revert default.

Tests in this order (matches AC order + dependency order):

1. **`initialize` happy path.** Route matches `repository(owner:$owner,name:$name){id}` query. Returns `{repository:{id:"R_kwBogus"}}`. Asserts client created; `t.calls.length === 1`.
2. **`createPr` non-draft.** Route matches `createPullRequest(input:` mutation. Returns `{createPullRequest:{pullRequest:{id:"PR_kw1",number:42,url:"…"}}}`. Asserts deep-equals on `t.calls[1]?.variables` including `draft:false`. Returned `PrInfo` deep-equals `{number:42, nodeId:"PR_kw1", url:"…"}`.
3. **`createPr` draft (salvage path).** Same as #2 but input has `draft:true`. Asserts `t.calls[1]?.variables.draft === true`. Body-shape pin: a future "drop the field when false" simplification would silently switch wire shape and fail this assertion or its sibling.
4. **`createPr` transport-failure THROWS.** Route throws `Error("HTTP 500: server")`. Asserts the call rejects; caught error message contains the canary. Same shape as #36's `addLabel` THROWS test — verbatim error pass-through.
5. **`enableAutoMerge` happy path.** Two routes: PR-id-by-number query (returns `{repository:{pullRequest:{id:"PR_kw1"}}}`), then `enablePullRequestAutoMerge` mutation. Asserts `t.calls.length === 2`, both methods invoked in order, mutation variables deep-equal `{pullRequestId:"PR_kw1"}`.
6. **`mergePr` happy path.** Two routes: resolve-id query, then `mergePullRequest` mutation returning success. Asserts result deep-equals `{merged:true}`. Asserts `t.calls.length === 2`.
7. **`mergePr` conflict** (the load-bearing test). Two routes: resolve-id query succeeds; `mergePullRequest` mutation route throws `Error("Pull Request is not mergeable: this branch has conflicts that must be resolved")`. Asserts:
    - Result is NOT a thrown error (no `try { ... } catch` needed in the test — `await client.mergePr(42)` resolves).
    - Result deep-equals `{merged:false, reason:"conflict", error:<the thrown Error>}` (use `expect(result.error.message).toContain("not mergeable")` rather than identity).
    - This is the test the entire ticket exists for. A future "throw on conflict" simplification fails this immediately.
8. **`mergePr` other-error** (defensive). Mutation route throws `Error("HTTP 500: server")`. Asserts `result.merged === false && result.reason === "other"`. The substring classifier should NOT misroute generic errors as conflicts.

**Lock-in tests not strictly required by AC but worth ~5 lines each:**

- `mergePr` conflict — case-insensitive substring match. Throw `Error("Pull Request is NOT MERGEABLE")` (uppercase) and assert `reason === "conflict"`. Pins the lowercase normalization in `classifyMergeError`.
- `createPr` body-shape — assert `variables.headRefName === input.head` AND `variables.baseRefName === input.base` (NOT swapped). The role-mapping pin for the head/base pair, parallel to #37's `issueId/blockingIssueId` pin.

**No real `gh` CLI invocations.** Per AC. The hand-rolled routing-table mock is the verification mechanism. Same posture as #19/#36/#37.

## File hygiene

- Hardcap 200 lines. Expected actual: **80–110 lines** including header. The `mergePr` typing is the line-count driver.
- No `process.env` reads.
- No imports from `src/index.ts`.
- No `@octokit` runtime dep added — `package.json` unchanged.
- No deriving order from `issueNumber` (PO note's #19-style guard — not applicable here, but pinned).
- Module exports: `GitHubPrClient`, `PrInfo`, `CreatePrInput`, `MergeResult`. `classifyMergeError`, `resolvePrNodeId`, raw response types are file-local.
- Header comment ~12–18 lines, in the style of `project-client.ts:1-17`'s prose: states what the module does, the load-bearing conflict-typing invariant on `mergePr`, and the "DOES NOT decide" disclaimer (the pure pipeline decides whether to merge; this module only executes).

## Open questions

- **Should `mergePr` accept `prNodeId` directly to skip the resolve roundtrip?** The salvage flow's `createPr → enableAutoMerge` could pass `PrInfo.nodeId` straight through to a number-or-nodeId-keyed mergePr. Out of scope per AC (`mergePr(prNumber)`). If a future hot path observes the doubled call cost, add an overload `mergePr(prNumber, opts?: { nodeId?: string })` — additive, no API break.
- **Does `enableAutoMerge` also need conflict typing?** No — enabling auto-merge succeeds even when the PR is currently conflicting (GitHub queues the merge until mergeable). The conflict surfaces only at merge-attempt time, which is `mergePr`'s concern. AC explicitly says "happy-path enable" — this is the deliberate scope.
- **Should `createPr` strip `draft: undefined` instead of defaulting to `false`?** Not symmetric with the "send required-with-default" decision in § createPr. The test mock matches a wire shape that always sends `draft:<bool>`; that's the contract. If a future caller wants "let GitHub decide," that's a separate primitive (`createPrInferDraft`) — adding now speculates on a hypothetical consumer.

## Implementation checklist (developer-facing)

1. Create `src/github/pr.ts` with the exports listed in § File hygiene. Header comment per the style note.
2. Create `test/github/pr.test.ts` with eight tests in the order listed in § Testing strategy. Inline-copy `makeTransport(routes)` from `test/github/blocked-by.test.ts:8-33`.
3. Run `pnpm typecheck && pnpm test && pnpm lint`. All green is the bar.
4. Verify final file is ≤ 200 lines (`wc -l src/github/pr.ts`).
