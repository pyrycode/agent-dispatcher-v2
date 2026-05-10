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

// Body is passed for POST/PATCH; GET passes undefined. Implementations MUST
// JSON-encode the body and set Content-Type: application/json. Implementations
// MUST throw / reject on non-2xx responses; this module does not catch.
export type RestTransport = (
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  body?: Record<string, unknown>,
) => Promise<unknown>;

// Narrow issue shape — only fields a downstream consumer reads. Per the #6
// narrow-types rule, do NOT widen for hypothetical future consumers; widen
// at the moment a caller needs `assignees` / `milestone` / `closedAt`.
export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly state: string;
  readonly url: string;
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

interface RawIssue {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly state?: unknown;
  readonly html_url?: unknown;
  readonly labels?: readonly { readonly name?: unknown }[];
}

export class GitHubIssuesClient {
  private constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly transport: RestTransport,
  ) {}

  // Synchronous factory — REST endpoints key on (owner, repo, number)
  // directly, so there is nothing to resolve up front (unlike #19's GraphQL
  // client, which had to cache project IDs). Static factory + private
  // constructor are kept for shape-symmetry with project-client and so
  // consumers can't accidentally construct an instance with a wrong-shape
  // transport.
  static create(
    opts: { owner: string; repo: string },
    transport: RestTransport,
  ): GitHubIssuesClient {
    return new GitHubIssuesClient(opts.owner, opts.repo, transport);
  }

  async getIssue(number: number): Promise<Issue> {
    const raw = await this.transport("GET", this.issuePath(number));
    return mapIssue(raw);
  }

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    const raw = await this.transport("POST", `/repos/${this.owner}/${this.repo}/issues`, {
      title: input.title,
      body: input.body,
      labels: input.labels,
    });
    return mapIssue(raw);
  }

  // Partial update. Omitting both `body` and `labels` resolves to `null`
  // without a transport call (AC: "Omitting both is a noop, not an error").
  // `!== undefined` (not truthiness) is load-bearing — callers can legitimately
  // pass `body: ""` to clear, or `labels: []` to drop all labels.
  // REST PATCH on `labels` is replace-set semantics: the array sent becomes
  // the new full label set.
  async updateIssue(number: number, patch: UpdateIssuePatch): Promise<Issue | null> {
    const body: Record<string, unknown> = {};
    if (patch.body !== undefined) body.body = patch.body;
    if (patch.labels !== undefined) body.labels = patch.labels;
    if (Object.keys(body).length === 0) return null;
    const raw = await this.transport("PATCH", this.issuePath(number), body);
    return mapIssue(raw);
  }

  private issuePath(number: number): string {
    return `/repos/${this.owner}/${this.repo}/issues/${number}`;
  }
}

// Field-level type guards reduce a malformed response to safe defaults
// rather than throwing — same posture as mapItem in project-client.ts.
// `body: null` (GitHub's wire shape for issues created without one) is
// substituted with `""` so the Issue.body: string contract holds.
function mapIssue(raw: unknown): Issue {
  const r = (raw ?? {}) as RawIssue;
  const labels: string[] = [];
  for (const l of r.labels ?? []) {
    if (typeof l.name === "string") labels.push(l.name);
  }
  return {
    number: typeof r.number === "number" ? r.number : 0,
    title: typeof r.title === "string" ? r.title : "",
    body: typeof r.body === "string" ? r.body : "",
    labels,
    state: typeof r.state === "string" ? r.state : "",
    url: typeof r.html_url === "string" ? r.html_url : "",
  };
}
