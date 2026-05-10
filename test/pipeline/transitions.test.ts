import { describe, expect, it } from "vitest";
import {
  COLUMNS,
  type Column,
  type Label,
  type LabelPattern,
  TRANSITIONS,
} from "../../src/pipeline/transitions.ts";

describe("COLUMNS reachability from Inbox", () => {
  it("includes Inbox as the entry column", () => {
    expect(COLUMNS).toContain("Inbox");
  });

  it("every Column other than Inbox is reachable from Inbox via at least one chain", () => {
    const visited = new Set<Column>(["Inbox"]);
    const queue: Column[] = ["Inbox"];
    while (queue.length > 0) {
      const cur = queue.shift() as Column;
      for (const t of TRANSITIONS) {
        if (t.from === cur && !visited.has(t.to)) {
          visited.add(t.to);
          queue.push(t.to);
        }
      }
    }
    for (const col of COLUMNS) {
      expect(visited.has(col), `unreachable: ${col}`).toBe(true);
    }
  });
});

describe("from/to membership in Column", () => {
  it("every from/to is a member of Column (no string literals leaking past the type)", () => {
    for (const t of TRANSITIONS) {
      expect(COLUMNS, `unknown from-column on row ${JSON.stringify(t)}`).toContain(t.from);
      expect(COLUMNS, `unknown to-column on row ${JSON.stringify(t)}`).toContain(t.to);
    }
  });
});

describe("strips patterns are not dead-letter", () => {
  it("every strips LabelPattern matches at least one label produced by some requires", () => {
    const allRequiredLabels = new Set<Label>();
    for (const t of TRANSITIONS) {
      for (const lbl of t.requires) allRequiredLabels.add(lbl);
    }
    const allStripPatterns = new Set<LabelPattern>();
    for (const t of TRANSITIONS) {
      for (const p of t.strips) allStripPatterns.add(p);
    }
    for (const pat of allStripPatterns) {
      const prefix = pat.endsWith("*") ? pat.slice(0, -1) : pat;
      const covered = [...allRequiredLabels].some((l) => l.startsWith(prefix));
      expect(covered, `dead-letter strip pattern: ${pat}`).toBe(true);
    }
  });
});
