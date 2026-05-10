import { describe, expect, it } from "vitest";
import { addBlockedBy } from "../../src/github/blocked-by.ts";
import type { GraphQLTransport } from "../../src/github/project-client.ts";

// Hand-rolled GraphQL transport with a routing table — match by query
// substring (or variables), respond with canned data or throw. The `calls`
// log is the verification mechanism for "transport receives the right
// variables" and "no fallback retry" assertions.
//
// Mirrors the inline helper in `test/github/project-client.test.ts:8-32`.
// Per the spec, do NOT extract to a shared `test/github/_helpers/transport.ts`
// until a third GraphQL consumer appears (this is the second).
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

describe("addBlockedBy", () => {
  it("invokes the addBlockedBy mutation with the right role mapping (blocked → issueId, blocker → blockingIssueId)", async () => {
    const t = makeTransport([
      {
        match: (q) => q.includes("addBlockedBy(input:"),
        respond: () => ({ addBlockedBy: { issue: { number: 42 } } }),
      },
    ]);
    await addBlockedBy("I_kwBlocked", "I_kwBlocker", t.fn);
    expect(t.calls.length).toBe(1);
    expect(t.calls[0]?.query.includes("addBlockedBy(input:")).toBe(true);
    // Load-bearing: deep-equals pins the role mapping. A future
    // "swap these for symmetry" simplification would set the dependency
    // the wrong way around and fail this assertion.
    expect(t.calls[0]?.variables).toEqual({
      issueId: "I_kwBlocked",
      blockingIssueId: "I_kwBlocker",
    });
  });

  it("propagates GraphQL errors verbatim on invalid node ID (no fallback retry)", async () => {
    const canary = "Could not resolve to a node with the global id of 'I_kwBogus'";
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
      await addBlockedBy("I_kwBogus", "I_kwBlocker", t.fn);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Could not resolve to a node");
    // No fallback retry — locks the no-fallback contract.
    expect(t.calls.length).toBe(1);
  });
});
