import { describe, expect, it } from "vitest";
import { type ReadyPrCandidate, findReadyPrNumber } from "../../src/pipeline/find-ready-pr.ts";

// Predicate-completeness audit — every PR-shape variant findReadyPrNumber
// distinguishes must have a row in the matrix below. Adding a future
// filter rule = adding a dimension, not a special case.
//
//   isDraft  errorLabeled   → ready?         covered by
//   ─────────────────────────────────────────────────────
//   true     true           → no              row A
//   true     false          → no              row B
//   false    true           → no              row C
//   false    false          → YES             row D
//
// Each row below carries an `// audit: row X` tag so a regression points
// at the exact failing variant.

function mkPr(number: number, isDraft: boolean, labels: readonly string[] = []): ReadyPrCandidate {
  return {
    number,
    nodeId: `node-${number}`,
    url: `https://example/${number}`,
    isDraft,
    labels,
  };
}

describe("findReadyPrNumber — empty / null cases", () => {
  it("returns null for empty input", () => {
    expect(findReadyPrNumber([])).toBeNull();
  });

  it("returns null when the only PR is a draft (no error labels)", () => {
    expect(findReadyPrNumber([mkPr(1, true, [])])).toBeNull();
  });

  it("returns null when the only PR is ready but error-labeled", () => {
    expect(findReadyPrNumber([mkPr(1, false, ["error:max_turns_salvaged"])])).toBeNull();
  });
});

describe("findReadyPrNumber — predicate-completeness 2×2 grid", () => {
  it("row A: isDraft=true, error-labeled → null", () => {
    // audit: row A
    expect(findReadyPrNumber([mkPr(1, true, ["error:max_turns_salvaged"])])).toBeNull();
  });

  it("row B: isDraft=true, no error label → null", () => {
    // audit: row B
    expect(findReadyPrNumber([mkPr(1, true, [])])).toBeNull();
  });

  it("row C: isDraft=false, error-labeled → null", () => {
    // audit: row C
    expect(findReadyPrNumber([mkPr(1, false, ["error:max_turns_salvaged"])])).toBeNull();
  });

  it("row D: isDraft=false, no error label → that PR's number", () => {
    // audit: row D
    expect(findReadyPrNumber([mkPr(1, false, [])])).toBe(1);
  });
});

describe("findReadyPrNumber — error:* prefix semantics", () => {
  it("filters out error:max_turns_salvaged", () => {
    expect(findReadyPrNumber([mkPr(1, false, ["error:max_turns_salvaged"])])).toBeNull();
  });

  it("filters out error:merge-conflict (different suffix; prefix match)", () => {
    expect(findReadyPrNumber([mkPr(1, false, ["error:merge-conflict"])])).toBeNull();
  });

  it("filters out a bare error: label (closed semantics)", () => {
    expect(findReadyPrNumber([mkPr(1, false, ["error:"])])).toBeNull();
  });

  it("does NOT filter something-error:foo (prefix match, not substring)", () => {
    expect(findReadyPrNumber([mkPr(1, false, ["something-error:foo"])])).toBe(1);
  });

  it("does NOT filter ready:code-review (no error: prefix; baseline)", () => {
    expect(findReadyPrNumber([mkPr(1, false, ["ready:code-review"])])).toBe(1);
  });
});

describe("findReadyPrNumber — multi-PR selection", () => {
  it("picks the lowest-numbered ready PR from two ready candidates", () => {
    expect(findReadyPrNumber([mkPr(5, false, []), mkPr(2, false, [])])).toBe(2);
  });

  it("picks the lowest-numbered ready PR from three ready candidates", () => {
    expect(findReadyPrNumber([mkPr(10, false, []), mkPr(3, false, []), mkPr(7, false, [])])).toBe(
      3,
    );
  });

  it("input order independence: [#10,#3,#7] → 3", () => {
    expect(findReadyPrNumber([mkPr(10, false, []), mkPr(3, false, []), mkPr(7, false, [])])).toBe(
      3,
    );
  });

  it("input order independence: [#7,#10,#3] → 3", () => {
    expect(findReadyPrNumber([mkPr(7, false, []), mkPr(10, false, []), mkPr(3, false, [])])).toBe(
      3,
    );
  });

  it("input order independence: [#3,#7,#10] → 3", () => {
    expect(findReadyPrNumber([mkPr(3, false, []), mkPr(7, false, []), mkPr(10, false, [])])).toBe(
      3,
    );
  });

  it("mixed: ready #7, draft #1, ready #3, error-labeled #2 → 3 (lowest qualifying)", () => {
    const prs: ReadyPrCandidate[] = [
      mkPr(7, false, []),
      mkPr(1, true, []),
      mkPr(3, false, []),
      mkPr(2, false, ["error:max_turns_salvaged"]),
    ];
    expect(findReadyPrNumber(prs)).toBe(3);
  });
});

describe("findReadyPrNumber — drafts mixed with ready", () => {
  it("returns the only ready PR among drafts", () => {
    const prs: ReadyPrCandidate[] = [mkPr(1, true, []), mkPr(2, true, []), mkPr(3, false, [])];
    expect(findReadyPrNumber(prs)).toBe(3);
  });

  it("returns null when all non-drafts are error-labeled", () => {
    const prs: ReadyPrCandidate[] = [
      mkPr(1, true, []),
      mkPr(2, false, ["error:max_turns_salvaged"]),
    ];
    expect(findReadyPrNumber(prs)).toBeNull();
  });
});
