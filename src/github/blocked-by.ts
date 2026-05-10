// Thin wrapper around GitHub's GraphQL `addBlockedBy` mutation. Marks a
// blocked issue as blocked by a blocker via the native sub-issue
// relationship that the dispatcher's `hasOpenBlockers` predicate (#6)
// reads. Pairs the architect's prose ("set the dependency") with a
// deterministic primitive — CLAUDE.md "Belt-and-suspenders".
//
// Two semantic invariants are load-bearing:
//
//   - Role mapping: `blockedNodeId` becomes the mutation's `issueId`
//     (the issue that becomes blocked); `blockerNodeId` becomes
//     `blockingIssueId` (the blocker). Reversing them silently sets
//     the dependency the wrong way around. The test deep-equals the
//     transport variables to pin this.
//   - Errors propagate verbatim — no try/catch, no fallback retry,
//     no message rewriting. An invalid node ID surfaces the underlying
//     `Could not resolve to a node` error intact.
//
// Takes node IDs (not issue numbers). Callers with only numbers resolve
// via `src/github/issues.ts` (#35) before calling here; the round-trip
// cost stays visible at the call site instead of hiding inside this
// primitive. Sibling primitives (removeBlockedBy, blockedBy queries)
// land in their own tickets when an observed call site appears.

import type { GraphQLTransport } from "./project-client.ts";

const ADD_BLOCKED_BY_MUTATION =
  "mutation($issueId:ID!,$blockingIssueId:ID!){addBlockedBy(input:{issueId:$issueId,blockingIssueId:$blockingIssueId}){issue{number}}}";

export async function addBlockedBy(
  blockedNodeId: string,
  blockerNodeId: string,
  transport: GraphQLTransport,
): Promise<void> {
  await transport(ADD_BLOCKED_BY_MUTATION, {
    issueId: blockedNodeId,
    blockingIssueId: blockerNodeId,
  });
}
