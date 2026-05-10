# Architecture spec — #36 `src/github/labels.ts`

Three thin label primitives — `addLabel`, `removeLabel`, `setLabels` — that
the dispatcher's loop layer applies the deltas decided by `decideLabelDelta`
through. This module makes no decisions; it executes them, and `addLabel`'s
load-bearing throw-on-failure semantic is the deterministic safety net for
the salvage flow's pre-PR labelling step.

## Files to read first

The developer's turn-1 reading list. Each entry has a one-line "what to extract."

- `src/github/issues.ts:16-20` — `RestTransport` callable type. **You will widen this union** by one literal (`"PUT"`) in this ticket. The current shape is `(method: "GET" | "POST" | "PATCH", path, body?) => Promise<unknown>`.
- `src/github/issues.ts:54-72` — `GitHubIssuesClient` static factory + private constructor pattern. **Mirror this shape** for `GitHubLabelsClient`: `static create({owner, repo}, transport)` synchronous factory, private ctor, transport stored once.
- `src/github/issues.ts:108-126` — `mapIssue` field-level type-guard pattern (`typeof x === "string"` per field, no throwing on shape drift). Mirror this for `mapLabels(raw): readonly string[]` against `[{name:string}, ...]` wire shape.
- `test/github/issues.test.ts:9-37` — `makeTransport(routes)` recording-transport mock. **Reuse this shape verbatim** — copy the helper, retype to `RestTransport` (already is), and route by `(method, path)` predicates.
- `test/github/issues.test.ts:42-66` — `issueResponse(num, opts)` canned-response fixture. You'll write a parallel `labelsResponse(names)` that returns `[{name}, ...]`.
- `test/github/issues.test.ts:225-272` — transport-errors-propagate-verbatim test pattern. **The `addLabel` transport-failure-throws AC is exactly this shape**, retyped for the labels POST.
- `src/github/project-client.ts:1-17` — header-comment style (load-bearing-invariant prose at top of file). Mirror tone/length for `labels.ts`'s header.
- `docs/PROJECT-MEMORY.md` § "src/github/ issues REST surface (#35)" — every bullet applies (DI seam, factory shape, narrow types, no `@octokit/rest` dep, tests hand-roll routing-table mocks). The ticket extends this surface; same posture.
- `docs/lessons.md` § "PATCH replace-set semantics on labels (#35)" — **this generalizes to PUT `/issues/{n}/labels`**. PUT replace-set has the same destructive failure mode if `labels: undefined` leaks into the body. Apply the same `if (... !== undefined)` discipline + deep-equals assertion on recorded request bodies.
- `CLAUDE.md` § "Belt-and-suspenders" — `addLabel` throwing on transport failure is exactly this pattern: a deterministic transport-level failure that backstops the agent's "remember to add the label" prose.

## Context

**Why now.** The salvage flow (#12) is the load-bearing consumer. When a developer/code-review run hits `max_turns`, salvage applies `error:max_turns_salvaged` BEFORE `gh pr create` so the PR is born with the global-block label. v1's lesson "addLabel ordering before pr-create" (2026-05-03) made the failure mode explicit: a salvage PR without its global-block label gets re-dispatched on the next cycle as a normal ready PR — silent transport failure here is operationally dangerous.

**Why a separate module.** PROJECT-MEMORY's #35 entry deferred standalone label helpers ("Callers compose via `updateIssue`'s `labels` patch — v2 hasn't observed a delta-style call site that doesn't first read"). #36 lifts that deferral because:

1. The salvage flow needs an `addLabel` primitive whose throw semantic is contract-level, not delta-style.
2. Rework routing wants to remove `ready:*` / `wip:*` / `error:*` without first reading — caller doesn't know which is set, just wants all three gone (idempotent removal).
3. `setLabels` is the natural primitive `decideLabelDelta` deltas would resolve to when a column transition strips one set and adds another.

**What this is not.** This module makes zero decisions. It does not call `decideLabelDelta`, does not key on label prefixes, does not filter `ready:*` patterns. The pure pipeline decides; this module writes.

## Design

### Module shape

```ts
// src/github/labels.ts

import type { RestTransport } from "./issues.ts";

export class GitHubLabelsClient {
  private constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly transport: RestTransport,
  ) {}

  static create(
    opts: { owner: string; repo: string },
    transport: RestTransport,
  ): GitHubLabelsClient { /* ... */ }

  // Throws on transport failure — load-bearing for salvage flow.
  // POST appends; GitHub dedupes server-side if `name` already present.
  async addLabel(number: number, name: string): Promise<void>;

  // Idempotent: GET current labels, filter; PUT replacement only if `name`
  // was actually present. Absent → zero mutating calls, no throw.
  async removeLabel(number: number, name: string): Promise<void>;

  // Replace-set semantics: PUT /labels with the given list verbatim.
  async setLabels(number: number, names: readonly string[]): Promise<void>;
}
```

All three return `Promise<void>` — callers don't read the post-write label list. Returning would force a narrow-shape decision and add API surface. If a future caller needs it, widen at that point.

### Endpoint choices

| Operation | Method | Path | Body | Calls |
|---|---|---|---|---|
| `addLabel` | `POST` | `/repos/{o}/{r}/issues/{n}/labels` | `{ labels: [name] }` | 1 |
| `removeLabel` (present) | `GET` then `PUT` | `/repos/{o}/{r}/issues/{n}/labels` | `{ labels: filtered }` | 2 |
| `removeLabel` (absent) | `GET` only | `/repos/{o}/{r}/issues/{n}/labels` | — | 1 |
| `setLabels` | `PUT` | `/repos/{o}/{r}/issues/{n}/labels` | `{ labels: names }` | 1 |

**Why all three target `/issues/{n}/labels`** (not `/issues/{n}` with the `labels` patch field). Endpoint family consistency: one path template, three verbs. The `/issues/{n}` PATCH path is `issues.ts`'s concern — `updateIssue` already wraps it. Mixing them would double the test surface for no behavioral gain.

**Why no `DELETE /labels/{name}` for removeLabel.** `DELETE` returns 404 when the label is absent, which the transport contract throws on. Idempotency would then require the module to inspect error shape (`error.status === 404`?) — that couples the module to a transport implementation detail (which the contract intentionally doesn't expose). Read-modify-write via GET+PUT keeps the transport contract opaque and idempotency falls out of the filter. Two calls is the cost; the dispatcher is single-threaded per ticket so the read/write race is not load-bearing.

**Why not a single `DELETE` method literal added to the union.** Same reasoning: the union widening doesn't buy idempotency on its own — it just enables the call. The 404-handling complexity remains. Defer DELETE until a use case wants its semantics (delete-and-throw-on-absent).

### `RestTransport` union widening (1-line edit in `issues.ts`)

In `src/github/issues.ts:16-20`, change:

```ts
export type RestTransport = (
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: Record<string, unknown>,
) => Promise<unknown>;
```

to:

```ts
export type RestTransport = (
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  body?: Record<string, unknown>,
) => Promise<unknown>;
```

This is the entire scope of the edit in `issues.ts`. **No call-site cascade**: existing callers (`getIssue` / `createIssue` / `updateIssue`) all pass one of the original three literals; widening is additive.

The PO's technical note explicitly green-lights "widening that union by one literal" as in-scope. We use exactly one (`"PUT"`).

### `mapLabels` — the `/labels` GET response shape

GitHub's `GET /issues/{n}/labels` returns an array of label objects: `[{ id, name, color, ... }, ...]` (NOT an issue with a labels field; the labels endpoint returns a bare array). Mirror `mapIssue`'s field-level type-guard posture:

```ts
interface RawLabel { readonly name?: unknown }

function mapLabels(raw: unknown): readonly string[] {
  const arr = Array.isArray(raw) ? (raw as readonly RawLabel[]) : [];
  const out: string[] = [];
  for (const l of arr) if (typeof l.name === "string") out.push(l.name);
  return out;
}
```

Defensive default to `[]` on shape drift — matches `mapIssue`'s `body: null → ""` posture from #35. Don't throw on malformed responses; let the transport own response-validation if it ever needs to.

### `removeLabel` filter & skip-when-absent

```ts
async removeLabel(number: number, name: string): Promise<void> {
  const current = await this.fetchCurrentLabels(number);
  if (!current.includes(name)) return;       // idempotent fast path
  const next = current.filter((l) => l !== name);
  await this.transport("PUT", this.labelsPath(number), { labels: next });
}
```

The skip-when-absent is what lets the "already-absent-noop" test assert **zero mutating calls** (only the GET). If we always PUT, the absent case still works on the server (PUT same set ≡ no-op) but the test can no longer pin "removeLabel didn't mutate when label wasn't there" — and that's the contract the rework-routing flow depends on (don't churn label set when nothing needs to change).

### `setLabels` — pass `names` through verbatim

```ts
async setLabels(number: number, names: readonly string[]): Promise<void> {
  await this.transport("PUT", this.labelsPath(number), { labels: names });
}
```

No filtering, no dedup, no normalization. If callers pass duplicates, GitHub dedupes; if callers pass `[]`, all labels are stripped (same as `updateIssue` with `labels: []`). This is the deliberate counterpart to `decideLabelDelta`'s output — the pure pipeline decides the exact set; this module writes it.

**`labels: undefined` cannot leak** because `setLabels`'s parameter type is `readonly string[]` (not `readonly string[] | undefined`); `[]` and `undefined` are distinguishable at the type level. The body construction is unconditional (`{ labels: names }`) — no conditional shape, no `Object.assign` spread. Test pins via deep-equals on the recorded request body.

### Why no `addLabel` skip-when-already-present optimization

The salvage flow is the sensitive consumer. Its semantic is: "ensure label is present before pr-create." If we skipped the POST when a cached "label already present" was true, we'd open a window where an externally-removed label silently isn't re-added. POST is a single call; idempotency is server-side (GitHub dedupes); the simplest implementation also has the strongest contract. **No conditional read.** This is the asymmetry with `removeLabel`: addLabel's failure mode is "salvage PR has no block label" (silent dispatcher loop bug); removeLabel's failure mode is "extra GitHub mutation when not needed" (cosmetic).

## Concurrency model

This module is synchronous in shape (no goroutines / workers / channels — the project is TypeScript with `Promise<void>` returns). Each public method is a single linear chain of awaited transport calls. The dispatcher's loop layer is single-threaded per ticket; concurrent calls to the same `(number, name)` aren't a contract this module owns. If a future loop becomes multi-threaded per ticket, race resolution lives at the loop seam, not here.

## Error handling

**All three methods propagate transport errors verbatim.** No catch blocks anywhere in the module. Specifically:

- `addLabel`: a thrown POST error surfaces as a thrown `addLabel`. **Test #2 pins this** — the salvage flow contract.
- `removeLabel`: a thrown GET error surfaces; a thrown PUT error surfaces. We do NOT catch the GET to "fall back to absent" — a 401 shouldn't be misread as "label not present."
- `setLabels`: a thrown PUT error surfaces.

This is structurally identical to `issues.ts`'s "transport errors propagate verbatim" describe block (`test/github/issues.test.ts:225-272`). The `addLabel` test mirrors that exact shape; `removeLabel` and `setLabels` don't get a dedicated propagation test in this ticket because the AC list doesn't include them — but the structural posture (no catch) makes their propagation derivable.

**Defense for the `labels: undefined` leak (lesson from #35).** `setLabels`'s parameter type rules it out by construction. `removeLabel`'s PUT body is built unconditionally as `{ labels: next }` where `next` is a `readonly string[]` from `.filter()` — also rules it out. `addLabel`'s POST body is `{ labels: [name] }` literal — name is `string` typed. The deep-equals assertions on recorded request bodies in tests are the canaries.

## Testing strategy

File: `test/github/labels.test.ts`. Reuse `makeTransport(routes)` from the issues tests verbatim — copy the helper or import from a shared test util (the issues test file is the precedent; copy is fine, both files live one level deep in `test/github/`).

The AC explicitly orders the tests; the developer should follow that order:

1. **`addLabel` happy path.** Route matches `(POST, /repos/{o}/{r}/issues/{n}/labels)`, responds with `[{name:"existing"}, {name:"newone"}]`. Assert: one transport call; `t.calls[0]?.body` deep-equals `{ labels: ["newone"] }`.
2. **`addLabel` transport-failure-throws.** Route throws `Error("HTTP 500: Server error")`. Assert: `addLabel(1, "x")` rejects; the caught error's message contains the canary string. Pattern is verbatim from `issues.test.ts:225-272`.
3. **`removeLabel` happy path (label present).** GET route returns `[{name:"a"}, {name:"b"}]`. PUT route matches `(PUT, /repos/{o}/{r}/issues/{n}/labels)` and responds with `[{name:"b"}]`. Assert: two transport calls in order GET then PUT; `t.calls[1]?.body` deep-equals `{ labels: ["b"] }`.
4. **`removeLabel` already-absent-noop.** GET route returns `[{name:"b"}]`. **No PUT route registered** — if PUT is called, the default `throw new Error("No route matched: PUT ...")` will fail the test. Assert: `removeLabel(1, "a")` resolves (no throw); `t.calls.length === 1`; `t.calls[0]?.method === "GET"`. Both assertions are load-bearing — a future "always PUT for symmetry" simplification would fail this test instantly.
5. **`setLabels` replaces existing labels.** PUT route matches `(PUT, /repos/{o}/{r}/issues/{n}/labels)`. Assert: one call; `t.calls[0]?.body` deep-equals `{ labels: ["x", "y"] }` for input `["x", "y"]`. Includes a regression guard: pass `[]` and assert `t.calls[0]?.body` is `{ labels: [] }` (NOT `{ labels: undefined }`, NOT `{}`).

**Lock-in tests not required by AC but worth ~5 lines each:**

- `addLabel` body-shape pin: assert `t.calls[0]?.body` is exactly `{ labels: [name] }` (not `{ labels: name }` — wrapped in array per GitHub's contract).
- `removeLabel` happy-path PUT body pin: deep-equal to ensure no `labels: undefined` leak.

These are the lessons-from-#35 canaries. Add them inline within the relevant `it()` blocks; don't manufacture a separate describe.

**No real `gh` CLI invocations.** Per AC. The hand-rolled routing-table mock is the verification mechanism. Same posture as #19/#35.

## Open questions

- **Should `setLabels(n, [])` be allowed to strip everything?** Per the design above, yes — PUT with empty array is the natural "all labels removed" operation. The dispatcher's `decideLabelDelta` should never produce an empty `add` set without a corresponding `remove` set, but this module shouldn't enforce that — it's the pure pipeline's invariant. Resolved: pass through verbatim.

- **Should `addLabel` accept `readonly string[]` for batch?** Out of scope. The salvage flow adds one label; the "fail loud" semantic is per-call. If a future caller needs batched add-with-throw semantics, that's a separate primitive (`addLabels(n, names)`) — adding a batch overload now speculates on a hypothetical consumer.

- **Should the module export free functions (`addLabel(client, n, name)`) instead of methods?** No — methods bind `(owner, repo, transport)` once via the constructor, mirroring `GitHubIssuesClient` and `GitHubProjectClient`. Free functions would force the DI triple at every call site. Pattern parity matters more than the marginal compositional gain.

## File hygiene

- Hardcap 200 lines. Expected actual: 60–80.
- No `process.env` reads.
- No imports from `src/index.ts`.
- No `@octokit` runtime dep added — `package.json` unchanged.
- Module exports `GitHubLabelsClient` only. `RawLabel` and `mapLabels` are file-local.
- Header comment ~10 lines, in the style of `issues.ts`'s top-of-file prose: states what the module does, what it does NOT decide, and the load-bearing throw-on-failure invariant for `addLabel`.

## Implementation checklist (developer-facing)

1. Widen the union literal in `src/github/issues.ts:17` from `"GET" | "POST" | "PATCH"` to `"GET" | "POST" | "PATCH" | "PUT"`. One-line edit. No tests change.
2. Create `src/github/labels.ts` with `GitHubLabelsClient` per § Design above.
3. Create `test/github/labels.test.ts` covering the five AC tests in order, plus the two lock-in body-shape pins.
4. Run `pnpm typecheck && pnpm test && pnpm lint`. All green is the bar.
