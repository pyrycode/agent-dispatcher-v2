import { describe, expect, it } from "vitest";
import { GitHubPrClient } from "../../src/github/pr.ts";
import type { GraphQLTransport } from "../../src/github/project-client.ts";

// Hand-rolled GraphQL transport with a routing table — match by query
// substring (or variables), respond with canned data or throw. The `calls`
// log is the verification mechanism for "transport receives the right
// variables" and "no fallback retry" assertions.
//
// Mirrors the inline helper in `test/github/blocked-by.test.ts:8-33` and
// `test/github/project-client.test.ts:8-32`. Per the #37 spec, do NOT
// extract to a shared `test/github/_helpers/transport.ts` — one more inline
// copy is the cheaper-to-revert default.
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

const REPO_ID_ROUTE: Route = {
  match: (q) => q.includes("repository(owner:$owner,name:$name){id}"),
  respond: () => ({ repository: { id: "R_kwBogus" } }),
};

const PR_ID_ROUTE: Route = {
  match: (q) => q.includes("pullRequest(number:$number)"),
  respond: () => ({ repository: { pullRequest: { id: "PR_kw1" } } }),
};

async function makeClient(extraRoutes: readonly Route[] = []): Promise<{
  client: GitHubPrClient;
  t: RecordingTransport;
}> {
  const t = makeTransport([REPO_ID_ROUTE, ...extraRoutes]);
  const client = await GitHubPrClient.initialize({ owner: "pyrycode", repo: "v2" }, t.fn);
  return { client, t };
}

describe("GitHubPrClient.initialize", () => {
  it("resolves the repository node ID via the preflight query", async () => {
    const t = makeTransport([REPO_ID_ROUTE]);
    const client = await GitHubPrClient.initialize({ owner: "pyrycode", repo: "v2" }, t.fn);
    expect(client).toBeInstanceOf(GitHubPrClient);
    expect(t.calls.length).toBe(1);
    expect(t.calls[0]?.variables).toEqual({ owner: "pyrycode", name: "v2" });
  });

  it("throws when the repository is not found", async () => {
    const t = makeTransport([
      {
        match: () => true,
        respond: () => ({ repository: null }),
      },
    ]);
    let caught: unknown;
    try {
      await GitHubPrClient.initialize({ owner: "pyrycode", repo: "missing" }, t.fn);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Repository not found: pyrycode/missing");
  });
});

describe("GitHubPrClient.createPr", () => {
  it("invokes the createPullRequest mutation with draft:false by default and returns the PR info", async () => {
    const { client, t } = await makeClient([
      {
        match: (q) => q.includes("createPullRequest(input:"),
        respond: () => ({
          createPullRequest: {
            pullRequest: {
              id: "PR_kw1",
              number: 42,
              url: "https://github.com/pyrycode/v2/pull/42",
            },
          },
        }),
      },
    ]);

    const info = await client.createPr({
      title: "Land feature X",
      body: "Body text",
      head: "feature/41",
      base: "main",
    });

    expect(info).toEqual({
      number: 42,
      nodeId: "PR_kw1",
      url: "https://github.com/pyrycode/v2/pull/42",
    });
    expect(t.calls.length).toBe(2);
    // Body-shape pin: deep-equals locks the wire shape, including draft:false.
    expect(t.calls[1]?.variables).toEqual({
      repositoryId: "R_kwBogus",
      title: "Land feature X",
      body: "Body text",
      baseRefName: "main",
      headRefName: "feature/41",
      draft: false,
    });
  });

  it("sends draft:true for the salvage path", async () => {
    const { client, t } = await makeClient([
      {
        match: (q) => q.includes("createPullRequest(input:"),
        respond: () => ({
          createPullRequest: {
            pullRequest: { id: "PR_kw2", number: 43, url: "u" },
          },
        }),
      },
    ]);
    await client.createPr({
      title: "Salvage PR",
      body: "salvaged",
      head: "feature/12",
      base: "main",
      draft: true,
    });
    expect(t.calls[1]?.variables.draft).toBe(true);
    // Role-mapping pin: head/base must NOT swap.
    expect(t.calls[1]?.variables.headRefName).toBe("feature/12");
    expect(t.calls[1]?.variables.baseRefName).toBe("main");
  });

  it("propagates transport errors verbatim (no try/catch, no fallback retry)", async () => {
    const { client, t } = await makeClient([
      {
        match: (q) => q.includes("createPullRequest(input:"),
        respond: () => {
          throw new Error("HTTP 500: server");
        },
      },
    ]);
    let caught: unknown;
    try {
      await client.createPr({ title: "t", body: "b", head: "h", base: "main" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("HTTP 500: server");
    // initialize call + one createPr attempt — no retry.
    expect(t.calls.length).toBe(2);
  });
});

describe("GitHubPrClient.enableAutoMerge", () => {
  it("resolves the PR node ID then invokes enablePullRequestAutoMerge", async () => {
    const { client, t } = await makeClient([
      PR_ID_ROUTE,
      {
        match: (q) => q.includes("enablePullRequestAutoMerge(input:"),
        respond: () => ({ enablePullRequestAutoMerge: { pullRequest: { number: 42 } } }),
      },
    ]);
    await client.enableAutoMerge(42);
    // initialize + resolve + mutation = 3 calls
    expect(t.calls.length).toBe(3);
    expect(t.calls[1]?.query.includes("pullRequest(number:$number)")).toBe(true);
    expect(t.calls[1]?.variables).toEqual({ owner: "pyrycode", name: "v2", number: 42 });
    expect(t.calls[2]?.query.includes("enablePullRequestAutoMerge(input:")).toBe(true);
    expect(t.calls[2]?.variables).toEqual({ pullRequestId: "PR_kw1" });
  });
});

describe("GitHubPrClient.mergePr", () => {
  it("returns {merged: true} on a successful merge", async () => {
    const { client, t } = await makeClient([
      PR_ID_ROUTE,
      {
        match: (q) => q.includes("mergePullRequest(input:"),
        respond: () => ({ mergePullRequest: { pullRequest: { number: 42, merged: true } } }),
      },
    ]);
    const result = await client.mergePr(42);
    expect(result).toEqual({ merged: true });
    expect(t.calls.length).toBe(3);
  });

  it("surfaces conflict as a typed value (does NOT throw) — the load-bearing test", async () => {
    const conflictMessage =
      "Pull Request is not mergeable: this branch has conflicts that must be resolved";
    const { client } = await makeClient([
      PR_ID_ROUTE,
      {
        match: (q) => q.includes("mergePullRequest(input:"),
        respond: () => {
          throw new Error(conflictMessage);
        },
      },
    ]);

    // No try/catch in the test — `mergePr` resolves rather than rejecting.
    const result = await client.mergePr(42);

    expect(result.merged).toBe(false);
    if (result.merged) throw new Error("unreachable: result.merged was true");
    expect(result.reason).toBe("conflict");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toContain("not mergeable");
  });

  it("classifies non-conflict transport failures as reason:'other'", async () => {
    const { client } = await makeClient([
      PR_ID_ROUTE,
      {
        match: (q) => q.includes("mergePullRequest(input:"),
        respond: () => {
          throw new Error("HTTP 500: server");
        },
      },
    ]);
    const result = await client.mergePr(42);
    expect(result.merged).toBe(false);
    if (result.merged) throw new Error("unreachable");
    expect(result.reason).toBe("other");
    expect(result.error.message).toContain("HTTP 500: server");
  });

  it("matches the conflict substring case-insensitively", async () => {
    const { client } = await makeClient([
      PR_ID_ROUTE,
      {
        match: (q) => q.includes("mergePullRequest(input:"),
        respond: () => {
          throw new Error("Pull Request is NOT MERGEABLE");
        },
      },
    ]);
    const result = await client.mergePr(42);
    expect(result.merged).toBe(false);
    if (result.merged) throw new Error("unreachable");
    expect(result.reason).toBe("conflict");
  });

  it("returns reason:'other' when the PR cannot be resolved (resolution failure is not a merge conflict)", async () => {
    const { client } = await makeClient([
      {
        match: (q) => q.includes("pullRequest(number:$number)"),
        respond: () => ({ repository: { pullRequest: null } }),
      },
    ]);
    const result = await client.mergePr(999);
    expect(result.merged).toBe(false);
    if (result.merged) throw new Error("unreachable");
    expect(result.reason).toBe("other");
    expect(result.error.message).toContain("Pull request not found");
  });
});
