import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractLastMessages } from "../../src/claude/jsonl.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "..", "fixtures", "claude-jsonl", "session.jsonl");

type AssistantContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "thinking"; thinking: string };

function assistantLine(blocks: AssistantContentBlock[]): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: blocks },
  });
}

function textAssistantLine(text: string): string {
  return assistantLine([{ type: "text", text }]);
}

function writeTmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jsonl-test-"));
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("extractLastMessages — captured session fixture (PR #138 regression pin)", () => {
  it("returns a non-empty array when called with n=5 on the captured fixture", async () => {
    const result = await extractLastMessages(FIXTURE_PATH, 5);
    expect(result.length).toBeGreaterThan(0);
  });

  it("every returned element is a non-empty string", async () => {
    const result = await extractLastMessages(FIXTURE_PATH, 5);
    for (const entry of result) {
      expect(typeof entry).toBe("string");
      expect(entry.length).toBeGreaterThan(0);
    }
  });

  it("does not leak stringified tool_use blocks into the output", async () => {
    const result = await extractLastMessages(FIXTURE_PATH, 5);
    for (const entry of result) {
      expect(entry).not.toContain('"type":"tool_use"');
      expect(entry).not.toContain('"type":"thinking"');
    }
  });
});

describe("extractLastMessages — n smaller than available (chronological order)", () => {
  let path: string;
  beforeAll(() => {
    const lines = [
      textAssistantLine("first"),
      textAssistantLine("middle"),
      textAssistantLine("last"),
    ];
    path = writeTmpFile("three.jsonl", lines.join("\n"));
  });

  it("returns the last 2 in chronological order", async () => {
    expect(await extractLastMessages(path, 2)).toEqual(["middle", "last"]);
  });

  it("returns the last 1", async () => {
    expect(await extractLastMessages(path, 1)).toEqual(["last"]);
  });
});

describe("extractLastMessages — n larger than available (no padding, no throw)", () => {
  it("returns all 3 messages when asked for 10", async () => {
    const lines = [
      textAssistantLine("first"),
      textAssistantLine("middle"),
      textAssistantLine("last"),
    ];
    const path = writeTmpFile("three-pad.jsonl", lines.join("\n"));
    const result = await extractLastMessages(path, 10);
    expect(result).toEqual(["first", "middle", "last"]);
    expect(result).toHaveLength(3);
  });
});

describe("extractLastMessages — filters non-assistant envelopes", () => {
  it("ignores queue-operation and user lines, keeps assistant text", async () => {
    const lines = [
      JSON.stringify({
        type: "queue-operation",
        operation: "noop",
        sessionId: "s",
        timestamp: "2026-05-11T00:00:00.000Z",
        content: {},
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "ping" },
        sessionId: "s",
        timestamp: "2026-05-11T00:00:01.000Z",
      }),
      textAssistantLine("pong"),
    ];
    const path = writeTmpFile("filter.jsonl", lines.join("\n"));
    expect(await extractLastMessages(path, 5)).toEqual(["pong"]);
  });

  it("excludes tool_use and thinking blocks within an assistant envelope", async () => {
    const mixed = assistantLine([
      { type: "thinking", thinking: "internal" },
      { type: "text", text: "before tool" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      { type: "text", text: "after tool" },
    ]);
    const path = writeTmpFile("mixed.jsonl", mixed);
    expect(await extractLastMessages(path, 5)).toEqual(["before tool", "after tool"]);
  });
});

describe("extractLastMessages — malformed-line tolerance", () => {
  it("skips a truncated mid-file line and keeps the surrounding complete lines", async () => {
    const contents = [
      textAssistantLine("alpha"),
      '{"type":"asssis',
      textAssistantLine("omega"),
    ].join("\n");
    const path = writeTmpFile("malformed.jsonl", contents);
    expect(await extractLastMessages(path, 5)).toEqual(["alpha", "omega"]);
  });

  it("returns [] for an empty file without throwing", async () => {
    const path = writeTmpFile("empty.jsonl", "");
    expect(await extractLastMessages(path, 5)).toEqual([]);
  });

  it("tolerates blank lines and CRLF line endings", async () => {
    const contents = `\r\n${textAssistantLine("one")}\r\n\r\n${textAssistantLine("two")}\r\n`;
    const path = writeTmpFile("crlf.jsonl", contents);
    expect(await extractLastMessages(path, 5)).toEqual(["one", "two"]);
  });

  it("skips lines that parse to non-objects (null, numbers, arrays)", async () => {
    const contents = ["null", "42", "[1,2,3]", textAssistantLine("survivor")].join("\n");
    const path = writeTmpFile("nonobj.jsonl", contents);
    expect(await extractLastMessages(path, 5)).toEqual(["survivor"]);
  });
});

describe("extractLastMessages — n clamp", () => {
  it("n === 0 returns []", async () => {
    const lines = [
      textAssistantLine("first"),
      textAssistantLine("middle"),
      textAssistantLine("last"),
    ];
    const path = writeTmpFile("zero.jsonl", lines.join("\n"));
    expect(await extractLastMessages(path, 0)).toEqual([]);
  });

  it("negative n clamps to 0", async () => {
    const lines = [textAssistantLine("a"), textAssistantLine("b")];
    const path = writeTmpFile("neg.jsonl", lines.join("\n"));
    expect(await extractLastMessages(path, -3)).toEqual([]);
  });
});
