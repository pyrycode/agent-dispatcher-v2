// REST wrappers for GitHub issue labels — addLabel / removeLabel / setLabels.
// Thin transport over /repos/{owner}/{repo}/issues/{n}/labels; this module
// holds no business logic. The pure pipeline (decideLabelDelta, #5) decides
// which labels to add/remove; this module is the application layer those
// deltas are written through.
//
// One load-bearing invariant: addLabel THROWS on transport failure. The
// salvage flow (#12) applies error:max_turns_salvaged BEFORE `gh pr create`,
// and a swallowed-error addLabel would produce a labeled-PR-without-label —
// the salvage PR would be re-dispatched on the next cycle as a normal ready
// PR. Per CLAUDE.md "Belt-and-suspenders": this is the deterministic
// transport-level safety net behind the agent's "remember to add the label"
// prose. removeLabel and setLabels propagate transport errors verbatim too;
// addLabel is the one whose throw is contractually load-bearing.
//
// Out of scope: batched addLabels (the salvage consumer adds one), DELETE
// /labels/{name} (its 404-on-absent semantics conflict with idempotency).

import type { RestTransport } from "./issues.ts";

interface RawLabel {
  readonly name?: unknown;
}

export class GitHubLabelsClient {
  private constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly transport: RestTransport,
  ) {}

  // Synchronous factory — endpoints key on (owner, repo, number) directly,
  // nothing to resolve up front. Mirrors GitHubIssuesClient.create.
  static create(
    opts: { owner: string; repo: string },
    transport: RestTransport,
  ): GitHubLabelsClient {
    return new GitHubLabelsClient(opts.owner, opts.repo, transport);
  }

  // POST appends; GitHub dedupes server-side if `name` is already present.
  // No conditional read — a "skip when cached as present" optimization
  // would open a window where an externally-removed label silently isn't
  // re-added, which is the salvage flow's exact failure mode.
  async addLabel(number: number, name: string): Promise<void> {
    await this.transport("POST", this.labelsPath(number), { labels: [name] });
  }

  // GET-then-PUT-only-if-present. The skip-when-absent fast path is the
  // contract the rework-routing flow depends on (don't churn the label set
  // when nothing needs to change). Idempotency falls out of the filter
  // rather than catching a 404, which would couple this module to a
  // transport implementation detail the contract doesn't expose.
  async removeLabel(number: number, name: string): Promise<void> {
    const current = await this.fetchCurrentLabels(number);
    if (!current.includes(name)) return;
    const next = current.filter((l) => l !== name);
    await this.transport("PUT", this.labelsPath(number), { labels: next });
  }

  // Replace-set semantics: PUT with the given list verbatim. No filtering,
  // no dedup, no normalization. `setLabels(n, [])` strips every label —
  // pass-through to the pure pipeline's decision. The parameter type
  // `readonly string[]` rules out a `labels: undefined` leak by construction.
  async setLabels(number: number, names: readonly string[]): Promise<void> {
    await this.transport("PUT", this.labelsPath(number), { labels: names });
  }

  private async fetchCurrentLabels(number: number): Promise<readonly string[]> {
    const raw = await this.transport("GET", this.labelsPath(number));
    return mapLabels(raw);
  }

  private labelsPath(number: number): string {
    return `/repos/${this.owner}/${this.repo}/issues/${number}/labels`;
  }
}

// Field-level type guard — defaults to `[]` on shape drift rather than
// throwing. Same posture as mapIssue in issues.ts: this module doesn't own
// response-validation; the transport does.
function mapLabels(raw: unknown): readonly string[] {
  const arr = Array.isArray(raw) ? (raw as readonly RawLabel[]) : [];
  const out: string[] = [];
  for (const l of arr) if (typeof l.name === "string") out.push(l.name);
  return out;
}
