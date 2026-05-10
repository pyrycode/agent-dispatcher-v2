// Pure decision functions for label transitions.
//
// Per CLAUDE.md § "decideLabelDelta is the only place labels mutate", every
// label-mutation site (pre-dispatch, post-run, rework routing, done-cleanup)
// funnels through decideLabelDelta. The function encodes no transition-rule
// logic of its own — it consults TRANSITIONS from ./transitions.ts and
// applies the row's strips patterns plus the after-state's labels. POJOs in,
// decisions out; no await, no gh / git / fs.

import { type Column, type Label, TRANSITIONS } from "./transitions.ts";

// State of a ticket at one end of a transition: the board column it's in
// and the transition-trigger labels it carries. `Label` is the closed union
// from transitions.ts — narrow on purpose. wip:*, error:*, size:*,
// priority:*, security-sensitive are dispatcher-run lifecycle / metadata,
// not transition triggers, and stay out until a transition consumes one.
export interface TransitionState {
  readonly column: Column;
  readonly labels: readonly Label[];
}

// Delta the caller applies via the GitHub label API. Both arrays are
// subsets of, respectively, after.labels and before.labels — the function
// never synthesizes a label out of thin air.
export interface LabelDelta {
  readonly add: readonly Label[];
  readonly remove: readonly Label[];
}

export function decideLabelDelta(before: TransitionState, after: TransitionState): LabelDelta {
  const row = TRANSITIONS.find((t) => t.from === before.column && t.to === after.column);
  if (!row) {
    throw new Error(
      `decideLabelDelta: no legal transition from "${before.column}" to "${after.column}"`,
    );
  }

  // LabelPattern uses trailing "*" as shorthand for prefix matching. Mirrors
  // hasNeedsReworkLabel's startsWith idiom in blockers.ts.
  const stripPrefixes = row.strips.map((p) => p.slice(0, -1));
  const beforeSet = new Set<string>(before.labels);
  const afterSet = new Set<string>(after.labels);

  const remove = before.labels.filter(
    (l) => !afterSet.has(l) && stripPrefixes.some((px) => l.startsWith(px)),
  );
  const add = after.labels.filter((l) => !beforeSet.has(l));

  return { add, remove };
}
