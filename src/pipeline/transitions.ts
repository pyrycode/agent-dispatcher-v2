// Legal column-to-column transitions as data. Single source of truth for
// downstream pure functions (decideLabelDelta in #5, selection + rework
// routing in #7). No logic, no I/O — types and constants only.
//
// Per CLAUDE.md § "decideLabelDelta is the only place labels mutate", every
// label-mutation site (auto-advance, rework routing, done-cleanup) reads
// from this table. If a transition isn't here, decideLabelDelta won't fire
// for it — so coverage of this table is structurally load-bearing.

// The seven Status values on the project board. Inbox is the entry column;
// Done is terminal. Tickets walk Backlog → In Architecture → In Development →
// In Code Review → In Documentation → Done in the happy path; rework routes
// fall back to a prior column.
export type Column =
  | "Inbox"
  | "Backlog"
  | "In Architecture"
  | "In Development"
  | "In Code Review"
  | "In Documentation"
  | "Done";

// Runtime mirror of Column. Tests + reachability code need a concrete list
// (TS literal types erase at runtime). Order matches the project board's
// happy-path column order so iteration reads naturally; consumers that need
// a Set should construct one at the call site.
export const COLUMNS: readonly Column[] = [
  "Inbox",
  "Backlog",
  "In Architecture",
  "In Development",
  "In Code Review",
  "In Documentation",
  "Done",
] as const;

// Labels that gate a transition. Per the #6 narrow-types rule, only labels
// that some transition actually requires are members of this union —
// wip:*, error:*, size:*, priority:*, security-sensitive are dispatcher
// state / metadata, not transition triggers, and stay out until a transition
// actually consumes one.
export type Label =
  | "ready:po"
  | "ready:architect"
  | "ready:developer"
  | "ready:code-review"
  | "ready:documentation"
  | "needs-rework:po"
  | "needs-rework:architect"
  | "needs-rework:developer"
  | "needs-rework:code-review";

// Wildcard prefix patterns used in Transition.strips. The trailing "*" is
// shorthand for "any label whose name starts with this prefix". Same closed
// set rule as Label: only patterns whose underlying labels can actually gate
// a transition belong here — keeps the dead-letter invariant test honest.
export type LabelPattern = "ready:*" | "needs-rework:*";

export interface Transition {
  readonly from: Column;
  readonly to: Column;
  // ALL labels in `requires` must be present for the transition to be legal.
  // Empty array = no label requirement (e.g. Inbox → Backlog is a manual
  // human triage move with no label trigger).
  readonly requires: readonly Label[];
  // Patterns of labels to strip on transition. Forward auto-advance rows
  // strip nothing (matches v1's runAutoAdvance "no strip" semantics);
  // rework + Done rows strip the trigger family + stale ready labels so the
  // target agent re-runs on a clean slate.
  readonly strips: readonly LabelPattern[];
}

export const TRANSITIONS: readonly Transition[] = [
  // ---------- Forward (happy-path auto-advance) ----------
  // Inbox → Backlog is a manual human-triage move (no label trigger). It
  // MUST be in the table — without it, the reachability invariant fails for
  // every column except Inbox.
  { from: "Inbox", to: "Backlog", requires: [], strips: [] },
  { from: "Backlog", to: "In Architecture", requires: ["ready:po"], strips: [] },
  { from: "In Architecture", to: "In Development", requires: ["ready:architect"], strips: [] },
  { from: "In Development", to: "In Code Review", requires: ["ready:developer"], strips: [] },
  { from: "In Code Review", to: "In Documentation", requires: ["ready:code-review"], strips: [] },
  // Done is terminal — strip stale trigger labels so a reopened ticket
  // doesn't carry old ready:* / needs-rework:* state into a re-run.
  {
    from: "In Documentation",
    to: "Done",
    requires: ["ready:documentation"],
    strips: ["ready:*", "needs-rework:*"],
  },

  // ---------- Rework (route back to target agent's column) ----------
  // Same-column rework rows (from === to) are legal: the column doesn't
  // change but labels do, and decideLabelDelta is the only place labels
  // mutate. Without these rows, #5 would have to special-case "label-only"
  // transitions outside the table.
  {
    from: "In Architecture",
    to: "Backlog",
    requires: ["needs-rework:po"],
    strips: ["ready:*", "needs-rework:*"],
  },
  {
    from: "In Architecture",
    to: "In Architecture",
    requires: ["needs-rework:architect"],
    strips: ["ready:*", "needs-rework:*"],
  },

  {
    from: "In Development",
    to: "Backlog",
    requires: ["needs-rework:po"],
    strips: ["ready:*", "needs-rework:*"],
  },
  {
    from: "In Development",
    to: "In Architecture",
    requires: ["needs-rework:architect"],
    strips: ["ready:*", "needs-rework:*"],
  },
  {
    from: "In Development",
    to: "In Development",
    requires: ["needs-rework:developer"],
    strips: ["ready:*", "needs-rework:*"],
  },

  {
    from: "In Code Review",
    to: "Backlog",
    requires: ["needs-rework:po"],
    strips: ["ready:*", "needs-rework:*"],
  },
  {
    from: "In Code Review",
    to: "In Architecture",
    requires: ["needs-rework:architect"],
    strips: ["ready:*", "needs-rework:*"],
  },
  {
    from: "In Code Review",
    to: "In Development",
    requires: ["needs-rework:developer"],
    strips: ["ready:*", "needs-rework:*"],
  },
  {
    from: "In Code Review",
    to: "In Code Review",
    requires: ["needs-rework:code-review"],
    strips: ["ready:*", "needs-rework:*"],
  },

  {
    from: "In Documentation",
    to: "Backlog",
    requires: ["needs-rework:po"],
    strips: ["ready:*", "needs-rework:*"],
  },
  {
    from: "In Documentation",
    to: "In Architecture",
    requires: ["needs-rework:architect"],
    strips: ["ready:*", "needs-rework:*"],
  },
  {
    from: "In Documentation",
    to: "In Development",
    requires: ["needs-rework:developer"],
    strips: ["ready:*", "needs-rework:*"],
  },
  {
    from: "In Documentation",
    to: "In Code Review",
    requires: ["needs-rework:code-review"],
    strips: ["ready:*", "needs-rework:*"],
  },
] as const;
