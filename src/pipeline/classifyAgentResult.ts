// Pure classifier over a parsed agent run; POJO in, discriminant out. No
// await, no gh / git / fs. Per CLAUDE.md § "Pure functions in src/pipeline/,
// I/O at the edges": the post-spawn orchestrator calls this to branch
// between the happy path and the agent-error path without parsing stream
// artifacts inline.
//
// Not here: rework detection from needs-rework:* labels lives in
// decideReworkRouting (routing.ts) — different input (labels) and different
// decision (which agent to re-run). Mapping the agent-error subcategories
// (max_turns / rate_limit / error) to specific error:* labels is the
// label-delta phase's job (decisions.ts + transitions.ts); the orchestrator
// reads result.exitReason directly when it needs the finer-grained reason.

import type { StreamParseResult } from "../claude/stream.ts";

export type AgentResultClass = "ok" | "agent-error";

export function classifyAgentResult(result: StreamParseResult): AgentResultClass {
  return result.exitReason === "success" ? "ok" : "agent-error";
}
