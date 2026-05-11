import { describe, expect, it } from "vitest";
import type { RestTransport } from "../../src/github/issues.ts";
import { GitHubLabelsClient } from "../../src/github/labels.ts";

// Reuses the routing-table transport mock pattern from issues.test.ts —
// match by (method, path, body), respond with canned data or throw. The
// `calls` log is the verification mechanism for "no mutating PUT when label
// is absent" and body-shape pinning assertions.
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

// GitHub's GET/POST/PUT /issues/{n}/labels returns a bare array of label
// objects: [{ id, name, color, ... }, ...]. The fixture matches the wire
// shape so mapLabels is tested against reality.
function labelsResponse(names: readonly string[]) {
  return names.map((name) => ({ name }));
}

const OWNER = "pyrycode";
const REPO = "agent-dispatcher-v2";
const labelsPath = (n: number) => `/repos/${OWNER}/${REPO}/issues/${n}/labels`;

function newClient(transport: RestTransport): GitHubLabelsClient {
  return GitHubLabelsClient.create({ owner: OWNER, repo: REPO }, transport);
}

// Tests --------------------------------------------------------------------

describe("GitHubLabelsClient.addLabel", () => {
  it("POSTs /repos/{owner}/{repo}/issues/{n}/labels with { labels: [name] }", async () => {
    const t = makeTransport([
      {
        match: (m, p) => m === "POST" && p === labelsPath(1),
        respond: () => labelsResponse(["existing", "newone"]),
      },
    ]);
    const client = newClient(t.fn);
    await client.addLabel(1, "newone");
    expect(t.calls.length).toBe(1);
    // Body-shape pin: GitHub's contract is `{ labels: [name] }` (array
    // wrapper), NOT `{ labels: name }`. A future "send the bare string"
    // simplification would break this immediately.
    expect(t.calls[0]?.body).toEqual({ labels: ["newone"] });
  });

  it("transport-failure THROWS — load-bearing for the salvage flow's pre-PR labelling", async () => {
    const canary = "HTTP 500: Server error";
    const t = makeTransport([
      {
        match: () => true,
        respond: () => {
          throw new Error(canary);
        },
      },
    ]);
    const client = newClient(t.fn);
    let caught: unknown;
    try {
      await client.addLabel(1, "x");
    } catch (err) {
      caught = err;
    }
    // The "swallowed return value" failure mode — addLabel returning
    // undefined on transport error rather than rejecting — would silently
    // produce a labeled-PR-without-label in salvage. This pins the throw.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Server error");
  });
});

describe("GitHubLabelsClient.removeLabel", () => {
  it("happy path — GETs current labels then PUTs the filtered set", async () => {
    const t = makeTransport([
      {
        match: (m, p) => m === "GET" && p === labelsPath(1),
        respond: () => labelsResponse(["a", "b"]),
      },
      {
        match: (m, p) => m === "PUT" && p === labelsPath(1),
        respond: () => labelsResponse(["b"]),
      },
    ]);
    const client = newClient(t.fn);
    await client.removeLabel(1, "a");
    expect(t.calls.length).toBe(2);
    expect(t.calls[0]?.method).toBe("GET");
    expect(t.calls[1]?.method).toBe("PUT");
    // Deep-equals canary: a `labels: undefined` leak in the PUT body would
    // strip ALL labels server-side instead of just removing "a".
    expect(t.calls[1]?.body).toEqual({ labels: ["b"] });
  });

  it("already-absent — GETs once, NO PUT, no throw (idempotent)", async () => {
    // No PUT route registered; the default `No route matched: PUT ...`
    // will fail the test if removeLabel tries to PUT when the label is
    // already absent.
    const t = makeTransport([
      {
        match: (m, p) => m === "GET" && p === labelsPath(1),
        respond: () => labelsResponse(["b"]),
      },
    ]);
    const client = newClient(t.fn);
    await client.removeLabel(1, "a");
    // Both assertions are load-bearing — a future "always PUT for symmetry"
    // simplification (PUT same set ≡ server no-op) would still satisfy
    // "no throw" but fails the call-count pin. The rework-routing flow
    // depends on no-mutation-when-nothing-needs-to-change.
    expect(t.calls.length).toBe(1);
    expect(t.calls[0]?.method).toBe("GET");
  });
});

describe("GitHubLabelsClient.setLabels", () => {
  it("PUTs /repos/{owner}/{repo}/issues/{n}/labels with the given list verbatim", async () => {
    const t = makeTransport([
      {
        match: (m, p) => m === "PUT" && p === labelsPath(1),
        respond: () => labelsResponse(["x", "y"]),
      },
    ]);
    const client = newClient(t.fn);
    await client.setLabels(1, ["x", "y"]);
    expect(t.calls.length).toBe(1);
    expect(t.calls[0]?.body).toEqual({ labels: ["x", "y"] });
  });

  it("setLabels(n, []) sends { labels: [] } — NOT { labels: undefined }, NOT {}", async () => {
    // Regression guard against the lessons.md #35 PATCH replace-set lesson
    // generalized to PUT: a `labels: undefined` leak would 422 server-side,
    // and `{}` would be a no-op instead of stripping all labels.
    const t = makeTransport([
      {
        match: (m, p) => m === "PUT" && p === labelsPath(1),
        respond: () => labelsResponse([]),
      },
    ]);
    const client = newClient(t.fn);
    await client.setLabels(1, []);
    expect(t.calls.length).toBe(1);
    expect(t.calls[0]?.body).toEqual({ labels: [] });
  });
});
