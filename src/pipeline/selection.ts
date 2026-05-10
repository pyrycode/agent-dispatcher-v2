// Pure dispatch selector. Implements the `selectDispatches.cap` term of
// CLAUDE.md's throughput equation:
//
//   actual_wip = min(
//     selectDispatches.cap,    ← here
//     decideAutoAdvance.backlog_cap,
//     blocker_chain,
//     MANUAL_ADVANCE_GATES,
//   )
//
// Walks caller-ordered items, skips ineligible (wip:* / open-blocker /
// non-consumed-column), stops at the cap. No await, no gh / git / fs —
// the I/O lives behind src/github/ and src/worktree/. See CLAUDE.md
// § "Pure functions in src/pipeline/, I/O at the edges".

import { type Blocker, hasOpenBlockers } from "./blockers.ts";
import type { Column } from "./transitions.ts";

// Agents that consume a column. Distinct from blockers.ts's AgentName
// (commit producers): "po" belongs here but not there. Per the #6
// narrow-types rule, each pipeline module owns its narrow type for its
// narrow concern; promote to a shared union only when a third caller
// actually needs both sets.
export type Agent = "po" | "architect" | "developer" | "code-review" | "documentation";

// Maps each agent to the column it consumes from. Encoded as data here
// rather than derived from TRANSITIONS — "label gates this transition"
// and "agent consumes this column" are distinct concerns. Inbox and Done
// have no consuming agent; items in those columns are silently skipped.
export const AGENT_COLUMN_MAP: Record<Agent, Column> = {
  po: "Backlog",
  architect: "In Architecture",
  developer: "In Development",
  "code-review": "In Code Review",
  documentation: "In Documentation",
};

export interface SelectionItem {
  // Status column on the project board. Items in non-mapped columns
  // (Inbox, Done) are skipped — they have no consuming agent.
  column: Column;
  issueNumber: number;
  // GitHub label names on the issue. Caller (src/github/) maps the
  // richer label objects to a string array before handing off.
  labels: readonly string[];
  // Open / closed blockers attached to the issue. Reuses the Blocker
  // shape from blockers.ts.
  blockers: readonly Blocker[];
}

export interface SelectionState {
  items: readonly SelectionItem[];
}

export interface DispatchTuple {
  readonly agent: Agent;
  readonly issueNumber: number;
}

const COLUMN_TO_AGENT: Partial<Record<Column, Agent>> = (() => {
  const out: Partial<Record<Column, Agent>> = {};
  for (const [agent, col] of Object.entries(AGENT_COLUMN_MAP) as [Agent, Column][]) {
    out[col] = agent;
  }
  return out;
})();

export function selectDispatches(state: SelectionState, maxConcurrent: number): DispatchTuple[] {
  if (maxConcurrent <= 0) return [];
  const result: DispatchTuple[] = [];
  for (const item of state.items) {
    if (result.length >= maxConcurrent) break;
    if (!isEligible(item)) continue;
    const agent = COLUMN_TO_AGENT[item.column];
    if (!agent) continue;
    result.push({ agent, issueNumber: item.issueNumber });
  }
  return result;
}

function isEligible(item: SelectionItem): boolean {
  if (hasWipLabel(item.labels)) return false;
  if (hasOpenBlockers(item.blockers)) return false;
  return true;
}

function hasWipLabel(labels: readonly string[]): boolean {
  return labels.some((l) => l.startsWith("wip:"));
}
