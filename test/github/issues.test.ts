import { describe, expect, it } from "vitest";
import { GitHubIssuesClient, type Issue, type RestTransport } from "../../src/github/issues.ts";

// Hand-rolled REST transport with a routing table — match by (method, path,
// body), respond with canned data or throw. The `calls` log is the
// verification mechanism for "no transport call on empty patch" and
// "transport receives the right method/path/body" assertions. Mirrors the
// pattern in test/github/project-client.test.ts retyped to RestTransport.
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

// Canned shapes — GitHub's REST API returns labels as objects `{ name, ... }`,
// not strings; the fixture matches the on-the-wire shape so mapIssue is
// tested against reality.
function issueResponse(
  num: number,
  opts: Partial<{
    title: string;
    body: string | null;
    labels: string[];
    state: string;
  }> = {},
) {
  return {
    number: num,
    title: opts.title ?? `Issue ${num}`,
    body: opts.body === undefined ? "" : opts.body,
    labels: (opts.labels ?? []).map((name) => ({ name })),
    state: opts.state ?? "open",
    html_url: `https://example.test/${num}`,
  };
}

const OWNER = "pyrycode";
const REPO = "agent-dispatcher-v2";

function newClient(transport: RestTransport): GitHubIssuesClient {
  return GitHubIssuesClient.create({ owner: OWNER, repo: REPO }, transport);
}

// Tests --------------------------------------------------------------------

describe("GitHubIssuesClient.getIssue", () => {
  it("GETs /repos/{owner}/{repo}/issues/{number} and maps to the narrow Issue shape", async () => {
    const t = makeTransport([
      {
        match: (m, p) => m === "GET" && p === `/repos/${OWNER}/${REPO}/issues/35`,
        respond: () => issueResponse(35, { body: "Hello", labels: ["size:S", "ready:architect"] }),
      },
    ]);
    const client = newClient(t.fn);
    const result = await client.getIssue(35);
    expect(result).toEqual({
      number: 35,
      title: "Issue 35",
      body: "Hello",
      labels: ["size:S", "ready:architect"],
      state: "open",
      url: "https://example.test/35",
    });
    // Lock-in: NO extra GitHub fields leak through. Mirrors project-client
    // test #9 — a future "let's expose html_url AND api_url" would fail here.
    expect(Object.keys(result).sort()).toEqual(
      ["body", "labels", "number", "state", "title", "url"].sort(),
    );
  });

  it("maps body:null → '' (the Issue.body: string contract, not string|null)", async () => {
    const t = makeTransport([
      {
        match: (m) => m === "GET",
        respond: () => issueResponse(1, { body: null }),
      },
    ]);
    const client = newClient(t.fn);
    const result = await client.getIssue(1);
    expect(result.body).toBe("");
  });

  it("deserializes labels from [{name}] objects to string[]", async () => {
    const t = makeTransport([
      {
        match: (m) => m === "GET",
        respond: () => issueResponse(1, { labels: ["a", "b"] }),
      },
    ]);
    const client = newClient(t.fn);
    const result: Issue = await client.getIssue(1);
    expect(result.labels).toEqual(["a", "b"]);
  });
});

describe("GitHubIssuesClient.createIssue", () => {
  it("POSTs /repos/{owner}/{repo}/issues with title/body/labels as plain string[]", async () => {
    const t = makeTransport([
      {
        match: (m, p) => m === "POST" && p === `/repos/${OWNER}/${REPO}/issues`,
        respond: () => issueResponse(99, { title: "New", body: "Body", labels: ["size:XS"] }),
      },
    ]);
    const client = newClient(t.fn);
    const result = await client.createIssue({
      title: "New",
      body: "Body",
      labels: ["size:XS"],
    });
    expect(result.number).toBe(99);
    expect(result.title).toBe("New");
    expect(result.body).toBe("Body");
    expect(result.labels).toEqual(["size:XS"]);
    // Locks "labels are passed as string[], not as [{name}]" — REST takes
    // names natively (no node-ID resolution).
    expect(t.calls[0]?.body).toEqual({
      title: "New",
      body: "Body",
      labels: ["size:XS"],
    });
  });
});

describe("GitHubIssuesClient.updateIssue", () => {
  it("partial body — PATCH body has body only, labels key absent", async () => {
    const t = makeTransport([
      {
        match: (m, p) => m === "PATCH" && p === `/repos/${OWNER}/${REPO}/issues/35`,
        respond: () => issueResponse(35, { body: "Updated body" }),
      },
    ]);
    const client = newClient(t.fn);
    const result = await client.updateIssue(35, { body: "Updated body" });
    expect(result?.body).toBe("Updated body");
    // Load-bearing: a regression where `labels: undefined` leaks into the
    // request body would replace the issue's labels with an empty set on
    // GitHub's side. This deep-equal is the canary.
    expect(t.calls[0]?.body).toEqual({ body: "Updated body" });
  });

  it("partial labels — PATCH body has labels only, body key absent", async () => {
    const t = makeTransport([
      {
        match: (m, p) => m === "PATCH" && p === `/repos/${OWNER}/${REPO}/issues/35`,
        respond: () => issueResponse(35, { labels: ["size:S"] }),
      },
    ]);
    const client = newClient(t.fn);
    const result = await client.updateIssue(35, { labels: ["size:S"] });
    expect(result?.labels).toEqual(["size:S"]);
    expect(t.calls[0]?.body).toEqual({ labels: ["size:S"] });
  });

  it("both fields — PATCH body has both", async () => {
    const t = makeTransport([
      {
        match: (m, p) => m === "PATCH" && p === `/repos/${OWNER}/${REPO}/issues/35`,
        respond: () => issueResponse(35, { body: "B", labels: ["L1", "L2"] }),
      },
    ]);
    const client = newClient(t.fn);
    await client.updateIssue(35, { body: "B", labels: ["L1", "L2"] });
    expect(t.calls[0]?.body).toEqual({ body: "B", labels: ["L1", "L2"] });
  });

  it("empty patch is a no-op — resolves to null AND issues zero transport calls", async () => {
    const t = makeTransport([
      {
        match: () => true,
        respond: () => {
          throw new Error("transport should not be called for empty patch");
        },
      },
    ]);
    const client = newClient(t.fn);
    const result = await client.updateIssue(35, {});
    // Both assertions are load-bearing. "No error" alone could be satisfied
    // by silently catching; "no transport call" alone could be satisfied by
    // returning a fake Issue. Together they pin the contract.
    expect(result).toBeNull();
    expect(t.calls.length).toBe(0);
  });

  it("body:'' is a real update, NOT a no-op (locks `!== undefined` semantics)", async () => {
    const t = makeTransport([
      {
        match: (m) => m === "PATCH",
        respond: () => issueResponse(35, { body: "" }),
      },
    ]);
    const client = newClient(t.fn);
    const result = await client.updateIssue(35, { body: "" });
    // A future `if (patch.body)` truthiness simplification would silently
    // drop empty-body updates and break this test immediately.
    expect(result).not.toBeNull();
    expect(t.calls.length).toBe(1);
    expect(t.calls[0]?.body).toEqual({ body: "" });
  });
});

describe("transport errors propagate verbatim", () => {
  const canary = "HTTP 401: Bad credentials";
  const throwing: Route = {
    match: () => true,
    respond: () => {
      throw new Error(canary);
    },
  };

  it("getIssue rejects with the transport's error intact", async () => {
    const t = makeTransport([throwing]);
    const client = newClient(t.fn);
    let caught: unknown;
    try {
      await client.getIssue(35);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Bad credentials");
  });

  it("createIssue rejects with the transport's error intact", async () => {
    const t = makeTransport([throwing]);
    const client = newClient(t.fn);
    let caught: unknown;
    try {
      await client.createIssue({ title: "x", body: "y", labels: [] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Bad credentials");
  });

  it("updateIssue rejects with the transport's error intact", async () => {
    const t = makeTransport([throwing]);
    const client = newClient(t.fn);
    let caught: unknown;
    try {
      await client.updateIssue(35, { body: "x" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Bad credentials");
  });
});
