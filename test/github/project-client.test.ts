import { describe, expect, it } from "vitest";
import {
  GitHubProjectClient,
  type GraphQLTransport,
  type ProjectItem,
} from "../../src/github/project-client.ts";

// Hand-rolled GraphQL transport with a routing table — match by query
// substring (or variables), respond with canned data or throw. The `calls`
// log is the verification mechanism for "transport receives the right
// ownerField" and "no fallback retry" assertions.
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

// Canned shapes ------------------------------------------------------------

const STATUS_FIELD = {
  id: "FIELD_STATUS",
  name: "Status",
  options: [
    { id: "OPT_BACKLOG", name: "Backlog" },
    { id: "OPT_IN_DEV", name: "In Development" },
  ],
};

function projectInitNode(extraFields: unknown[] = []) {
  return {
    projectV2: {
      id: "PVT_x",
      fields: { nodes: [STATUS_FIELD, ...extraFields] },
    },
  };
}

function issueNode(num: number, status = "Backlog", labels: string[] = []) {
  return {
    id: `PVTI_${num}`,
    fieldValueByName: { name: status },
    content: {
      number: num,
      title: `Issue ${num}`,
      url: `https://example.test/${num}`,
      labels: { nodes: labels.map((name) => ({ name })) },
    },
  };
}

function itemsPage(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return {
    node: {
      items: {
        pageInfo: { hasNextPage, endCursor },
        nodes,
      },
    },
  };
}

const initOrgRoute: Route = {
  match: (q) => q.includes("organization(login:") && q.includes("projectV2(number:"),
  respond: () => ({ organization: projectInitNode() }),
};

const initUserRoute: Route = {
  match: (q) => q.includes("user(login:") && q.includes("projectV2(number:"),
  respond: () => ({ user: projectInitNode() }),
};

const emptyItemsRoute: Route = {
  match: (q) => q.includes("orderBy:"),
  respond: () => itemsPage([]),
};

// Tests --------------------------------------------------------------------

describe("GitHubProjectClient.initialize", () => {
  it("succeeds for ownerType=organization and uses the organization() lookup", async () => {
    const t = makeTransport([initOrgRoute, emptyItemsRoute]);
    const client = await GitHubProjectClient.initialize(
      { owner: "pyrycode", project: 7, ownerType: "organization" },
      t.fn,
    );
    // Smoke-call to prove the instance is usable post-init.
    const items = await client.listItemsInBoardOrder();
    expect(items).toEqual([]);
    expect(t.calls[0]?.query.includes("organization(")).toBe(true);
    expect(t.calls[0]?.query.includes("user(")).toBe(false);
  });

  it("succeeds for ownerType=user and uses the user() lookup", async () => {
    const t = makeTransport([initUserRoute, emptyItemsRoute]);
    const client = await GitHubProjectClient.initialize(
      { owner: "alice", project: 1, ownerType: "user" },
      t.fn,
    );
    expect(client).toBeDefined();
    expect(t.calls[0]?.query.includes("user(")).toBe(true);
    expect(t.calls[0]?.query.includes("organization(")).toBe(false);
  });

  it("propagates GraphQL errors verbatim on mismatched ownerType (no fallback)", async () => {
    const canary = "Could not resolve to a User with the login of 'pyrycode'";
    const t = makeTransport([
      {
        match: () => true,
        respond: () => {
          throw new Error(canary);
        },
      },
    ]);
    let caught: unknown;
    try {
      await GitHubProjectClient.initialize(
        { owner: "pyrycode", project: 7, ownerType: "user" },
        t.fn,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(canary);
    // No fallback retry as the other ownerType.
    expect(t.calls.length).toBe(1);
  });

  it("throws when the Status field is missing from the project", async () => {
    const t = makeTransport([
      {
        match: (q) => q.includes("organization(login:"),
        respond: () => ({
          organization: {
            projectV2: {
              id: "PVT_x",
              fields: { nodes: [{ id: "FIELD_OTHER", name: "Priority", options: [] }] },
            },
          },
        }),
      },
    ]);
    await expect(
      GitHubProjectClient.initialize(
        { owner: "pyrycode", project: 7, ownerType: "organization" },
        t.fn,
      ),
    ).rejects.toThrow(/Status field not found/);
  });
});

describe("GitHubProjectClient.listItemsInBoardOrder", () => {
  it("returns items in POSITION order (the order the transport gives), not sorted by issueNumber", async () => {
    const scrambled = [issueNode(50), issueNode(10), issueNode(30), issueNode(20)];
    const t = makeTransport([
      initOrgRoute,
      {
        match: (q) => q.includes("orderBy:"),
        respond: () => itemsPage(scrambled),
      },
    ]);
    const client = await GitHubProjectClient.initialize(
      { owner: "pyrycode", project: 7, ownerType: "organization" },
      t.fn,
    );
    const items = await client.listItemsInBoardOrder();
    expect(items.map((i) => i.issueNumber)).toEqual([50, 10, 30, 20]);
    // Lock-in: NOT re-sorted by issueNumber. A future "let's sort for stability"
    // simplification breaks this assertion immediately.
    expect(items.map((i) => i.issueNumber)).not.toEqual([10, 20, 30, 50]);
  });

  it("paginates via pageInfo.endCursor and concatenates pages in transport order", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => issueNode(i + 1));
    const page2 = Array.from({ length: 5 }, (_, i) => issueNode(101 + i));
    let itemCallCount = 0;
    const t = makeTransport([
      initOrgRoute,
      {
        match: (q) => q.includes("orderBy:"),
        respond: () => {
          itemCallCount += 1;
          if (itemCallCount === 1) return itemsPage(page1, true, "C1");
          return itemsPage(page2, false, null);
        },
      },
    ]);
    const client = await GitHubProjectClient.initialize(
      { owner: "pyrycode", project: 7, ownerType: "organization" },
      t.fn,
    );
    const items = await client.listItemsInBoardOrder();
    expect(items.length).toBe(105);
    expect(items[0]?.issueNumber).toBe(1);
    expect(items[104]?.issueNumber).toBe(105);
    const itemQueryCalls = t.calls.filter((c) => c.query.includes("orderBy:"));
    expect(itemQueryCalls.length).toBe(2);
    expect(itemQueryCalls[1]?.variables.cursor).toBe("C1");
  });

  it("throws when pagination exceeds MAX_PAGES (runaway-loop guard)", async () => {
    const t = makeTransport([
      initOrgRoute,
      {
        match: (q) => q.includes("orderBy:"),
        // Always says "more pages" with the same cursor — runaway.
        respond: () => itemsPage([issueNode(1)], true, "always"),
      },
    ]);
    const client = await GitHubProjectClient.initialize(
      { owner: "pyrycode", project: 7, ownerType: "organization" },
      t.fn,
    );
    await expect(client.listItemsInBoardOrder()).rejects.toThrow(/exceeded \d+ pages/);
  });

  it("skips non-Issue content nodes (PR fragments, DraftIssue)", async () => {
    const mixed = [
      issueNode(1),
      // Simulates a non-Issue content fragment — number is not a number.
      {
        id: "PVTI_pr",
        fieldValueByName: { name: "Backlog" },
        content: {},
      },
    ];
    const t = makeTransport([
      initOrgRoute,
      {
        match: (q) => q.includes("orderBy:"),
        respond: () => itemsPage(mixed),
      },
    ]);
    const client = await GitHubProjectClient.initialize(
      { owner: "pyrycode", project: 7, ownerType: "organization" },
      t.fn,
    );
    const items = await client.listItemsInBoardOrder();
    expect(items.length).toBe(1);
    expect(items[0]?.issueNumber).toBe(1);
  });

  it("maps to the narrow ProjectItem shape — no extra GraphQL keys leak through", async () => {
    const t = makeTransport([
      initOrgRoute,
      {
        match: (q) => q.includes("orderBy:"),
        respond: () => itemsPage([issueNode(42, "In Development", ["ready:developer", "size:S"])]),
      },
    ]);
    const client = await GitHubProjectClient.initialize(
      { owner: "pyrycode", project: 7, ownerType: "organization" },
      t.fn,
    );
    const items = await client.listItemsInBoardOrder();
    expect(items.length).toBe(1);
    const item = items[0] as ProjectItem;
    expect(Object.keys(item).sort()).toEqual(
      ["id", "issueNumber", "labels", "status", "title", "url"].sort(),
    );
    expect(item.id).toBe("PVTI_42");
    expect(item.issueNumber).toBe(42);
    expect(item.title).toBe("Issue 42");
    expect(item.url).toBe("https://example.test/42");
    expect(item.status).toBe("In Development");
    expect(item.labels).toEqual(["ready:developer", "size:S"]);
  });

  it("falls back to a 'no-status' sentinel when fieldValueByName is null", async () => {
    const node = {
      id: "PVTI_99",
      fieldValueByName: null,
      content: {
        number: 99,
        title: "Untriaged",
        url: "https://example.test/99",
        labels: { nodes: [] },
      },
    };
    const t = makeTransport([
      initOrgRoute,
      {
        match: (q) => q.includes("orderBy:"),
        respond: () => itemsPage([node]),
      },
    ]);
    const client = await GitHubProjectClient.initialize(
      { owner: "pyrycode", project: 7, ownerType: "organization" },
      t.fn,
    );
    const items = await client.listItemsInBoardOrder();
    expect(items.length).toBe(1);
    expect(items[0]?.status).toBe("no-status");
  });
});
