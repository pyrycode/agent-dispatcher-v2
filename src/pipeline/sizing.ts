// Pure predicates for ticket-size gating and open-PR file overlap.
//
// Thresholds encode CLAUDE.md § "Sizing" (XS <30, S <100). They are exported
// as named constants so any future policy edit must surface here and trip the
// boundary tests, rather than silently drift the gate. File-overlap is exact
// string match — caller (src/github/, src/git/) canonicalises paths at the
// boundary. See CLAUDE.md § "Pure functions in src/pipeline/, I/O at the
// edges": no await, no gh / git / fs calls in this file.

export const XS_MAX_PRODUCTION_LINES = 30;
export const S_MAX_PRODUCTION_LINES = 100;

export interface SizingDiff {
  // Net production lines the change adds; tests are excluded by the caller
  // before this shape is constructed.
  productionLines: number;
}

export interface OpenPr {
  // Repo-root-relative file paths this PR touches. Caller maps GitHub's
  // PR-files payload to a string array before handing off.
  touchedFiles: readonly string[];
}

export function isXS(diff: SizingDiff): boolean {
  return diff.productionLines < XS_MAX_PRODUCTION_LINES;
}

export function isS(diff: SizingDiff): boolean {
  return diff.productionLines < S_MAX_PRODUCTION_LINES;
}

export function fileOverlapsAny(
  touchedFiles: readonly string[],
  openPrs: readonly OpenPr[],
): boolean {
  if (touchedFiles.length === 0) return false;
  if (openPrs.length === 0) return false;
  const candidate = new Set(touchedFiles);
  return openPrs.some((pr) => pr.touchedFiles.some((f) => candidate.has(f)));
}
