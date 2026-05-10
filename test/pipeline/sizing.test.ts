import { describe, expect, it } from "vitest";
import {
  S_MAX_PRODUCTION_LINES,
  XS_MAX_PRODUCTION_LINES,
  fileOverlapsAny,
  isS,
  isXS,
} from "../../src/pipeline/sizing.ts";

describe("isXS", () => {
  it("returns true for a zero-line diff", () => {
    expect(isXS({ productionLines: 0 })).toBe(true);
  });

  it("returns true at one under the threshold (29 < 30)", () => {
    expect(isXS({ productionLines: 29 })).toBe(true);
  });

  it("returns false at the threshold itself (30 is NOT XS)", () => {
    expect(isXS({ productionLines: 30 })).toBe(false);
  });

  it("returns false for a diff well above the threshold", () => {
    expect(isXS({ productionLines: 100 })).toBe(false);
  });
});

describe("isS", () => {
  it("returns true for a zero-line diff", () => {
    expect(isS({ productionLines: 0 })).toBe(true);
  });

  it("returns true for an XS-sized diff (XS implies S)", () => {
    expect(isS({ productionLines: 29 })).toBe(true);
  });

  it("returns true at one under the threshold (99 < 100)", () => {
    expect(isS({ productionLines: 99 })).toBe(true);
  });

  it("returns false at the threshold itself (100 is NOT S)", () => {
    expect(isS({ productionLines: 100 })).toBe(false);
  });

  it("returns false for a diff well above the threshold", () => {
    expect(isS({ productionLines: 200 })).toBe(false);
  });
});

describe("threshold constants", () => {
  it("pins XS_MAX_PRODUCTION_LINES to the CLAUDE.md value (30)", () => {
    expect(XS_MAX_PRODUCTION_LINES).toBe(30);
  });

  it("pins S_MAX_PRODUCTION_LINES to the CLAUDE.md value (100)", () => {
    expect(S_MAX_PRODUCTION_LINES).toBe(100);
  });
});

describe("fileOverlapsAny", () => {
  it("returns false when both inputs are empty", () => {
    expect(fileOverlapsAny([], [])).toBe(false);
  });

  it("returns false when the open-PR list is empty", () => {
    expect(fileOverlapsAny(["a.ts"], [])).toBe(false);
  });

  it("returns false when the candidate touched-files list is empty", () => {
    expect(fileOverlapsAny([], [{ touchedFiles: ["a.ts"] }])).toBe(false);
  });

  it("returns false when no candidate file appears in any open PR", () => {
    expect(fileOverlapsAny(["a.ts"], [{ touchedFiles: ["b.ts"] }])).toBe(false);
  });

  it("returns true on a single-file overlap", () => {
    expect(fileOverlapsAny(["a.ts"], [{ touchedFiles: ["a.ts"] }])).toBe(true);
  });

  it("returns true when the overlap is on the second PR and the second candidate file", () => {
    expect(
      fileOverlapsAny(
        ["a.ts", "b.ts"],
        [{ touchedFiles: ["c.ts"] }, { touchedFiles: ["b.ts", "d.ts"] }],
      ),
    ).toBe(true);
  });

  it("treats path matching as case-sensitive (no normalization)", () => {
    expect(fileOverlapsAny(["A.ts"], [{ touchedFiles: ["a.ts"] }])).toBe(false);
  });
});
