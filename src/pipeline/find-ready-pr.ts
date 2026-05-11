// Pure predicate that picks the lowest-numbered "ready" PR from a list of
// candidates supplied by a future src/github/ list-PRs query. "Ready" means
// not a draft AND no label matching the `error:*` global-block prefix.
// See CLAUDE.md § "Pure functions in src/pipeline/, I/O at the edges": no
// await, no gh / git / fs / process.env, no imports from src/github/ (except
// the type-only PrInfo seam), src/claude/, src/worktree/, src/salvage/, or
// src/index.ts.
//
// The 2×2 (isDraft × errorLabeled) variant grid IS the predicate-completeness
// audit (test/pipeline/find-ready-pr.test.ts). A future filter rule adds a
// dimension to the grid, not a special case here.

import type { PrInfo } from "../github/pr.ts";

// Narrow input shape. Extends PrInfo with the two fields the predicate
// reads; the upstream list-PRs query in src/github/ will return a structural
// superset of PrInfo, so this seam stays type-anchored without importing
// any function from that module. Per the #6 narrow-types rule, do NOT
// widen for hypothetical future consumers (createdAt, author, ...) — add
// when an observed predicate needs the field.
export interface ReadyPrCandidate extends PrInfo {
  readonly isDraft: boolean;
  readonly labels: readonly string[];
}

const ERROR_LABEL_PREFIX = "error:";

export function findReadyPrNumber(prs: readonly ReadyPrCandidate[]): number | null {
  let lowest: number | null = null;
  for (const pr of prs) {
    if (pr.isDraft) continue;
    if (hasErrorLabel(pr.labels)) continue;
    if (lowest === null || pr.number < lowest) {
      lowest = pr.number;
    }
  }
  return lowest;
}

function hasErrorLabel(labels: readonly string[]): boolean {
  return labels.some((l) => l.startsWith(ERROR_LABEL_PREFIX));
}
