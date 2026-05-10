// Pure rework-routing decision over a ticket's labels.
//
// Per CLAUDE.md § "Pure functions in src/pipeline/, I/O at the edges": no
// await, no gh / git / fs. POJOs in, decisions out. Mirrors v1's
// runReworkRouting strip contract: when a reviewing agent flags
// needs-rework:<target>, the dispatcher loop needs (a) which agent to re-run
// and (b) which stale state to strip so the target runs on a clean slate.
//
// Note: decideLabelDelta (decisions.ts) already strips ready:* and
// needs-rework:* per the transitions table, but it does NOT touch wip:* /
// error:* — those aren't transition triggers, they're dispatcher run-state.
// Rework routing is the only place that surfaces them, which is why this is
// a separate function.

import type { Label } from "./transitions.ts";

// Derived from Label so adding a needs-rework target in transitions.ts
// surfaces in Agent automatically — single source of truth. Yields
// "po" | "architect" | "developer" | "code-review" today.
type ExtractAgent<L> = L extends `needs-rework:${infer A}` ? A : never;
export type Agent = ExtractAgent<Label>;

export interface ReworkRouting {
  readonly target: Agent | null;
  readonly stripLabels: readonly string[];
}

const REWORK_PREFIX = "needs-rework:";
const STRIP_PREFIXES = ["ready:", "wip:", "error:"] as const;

export function decideReworkRouting(labels: readonly string[]): ReworkRouting {
  let target: Agent | null = null;
  let reworkLabel: string | null = null;
  for (const l of labels) {
    if (l.startsWith(REWORK_PREFIX) && l.length > REWORK_PREFIX.length) {
      target = l.slice(REWORK_PREFIX.length) as Agent;
      reworkLabel = l;
      break;
    }
  }

  if (target === null) return { target: null, stripLabels: [] };

  const stripLabels = labels.filter(
    (l) => l !== reworkLabel && STRIP_PREFIXES.some((px) => l.startsWith(px)),
  );
  return { target, stripLabels };
}
