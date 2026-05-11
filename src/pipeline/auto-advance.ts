// Pure auto-advance decision function. Implements the
// `decideAutoAdvance.backlog_cap` term of CLAUDE.md's throughput equation:
//
//   actual_wip = min(
//     selectDispatches.cap,
//     decideAutoAdvance.backlog_cap,   ← here
//     blocker_chain,
//     MANUAL_ADVANCE_GATES,
//   )
//
// Walks caller-ordered items, filters Backlog rows by eligibility, emits
// promotions up to the effective capacity (maxConcurrent - inFlightCount).
// No await, no gh / git / fs — the I/O lives behind src/github/. See
// CLAUDE.md § "Pure functions in src/pipeline/, I/O at the edges".

import { hasOpenBlockers } from "./blockers.ts";
import type { SelectionItem } from "./selection.ts";
import type { Column } from "./transitions.ts";

export interface AutoAdvanceState {
  items: readonly SelectionItem[];
}

export interface AdvanceDecision {
  readonly issueNumber: number;
  readonly to: Column;
}

export function decideAutoAdvance(
  state: AutoAdvanceState,
  inFlightCount: number,
  maxConcurrent: number,
): AdvanceDecision[] {
  const capacity = Math.max(0, maxConcurrent - inFlightCount);
  if (capacity === 0) return [];
  const result: AdvanceDecision[] = [];
  for (const item of state.items) {
    if (result.length >= capacity) break;
    if (!isEligible(item)) continue;
    result.push({ issueNumber: item.issueNumber, to: "In Architecture" });
  }
  return result;
}

function isEligible(item: SelectionItem): boolean {
  if (item.column !== "Backlog") return false;
  if (!item.labels.includes("ready:po")) return false;
  if (hasWipLabel(item.labels)) return false;
  if (hasOpenBlockers(item.blockers)) return false;
  return true;
}

function hasWipLabel(labels: readonly string[]): boolean {
  return labels.some((l) => l.startsWith("wip:"));
}
