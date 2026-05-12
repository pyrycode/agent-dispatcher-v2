import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeLastMessagesSection } from "../../src/salvage/last-messages.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "last-messages-test-"));
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

const HEADER = "**Last messages from the agent:**";
const PLACEHOLDER = "_(no assistant messages captured)_";

describe("composeLastMessagesSection — header is always present", () => {
  it("non-empty file: result starts with the literal header followed by a blank line", async () => {
    const path = writeTmpFile("one.jsonl", textAssistantLine("hello"));
    const result = await composeLastMessagesSection(path, 3);
    expect(result.startsWith(`${HEADER}\n\n`)).toBe(true);
  });

  it("empty file: result starts with the literal header followed by a blank line", async () => {
    const path = writeTmpFile("empty.jsonl", "");
    const result = await composeLastMessagesSection(path, 3);
    expect(result.startsWith(`${HEADER}\n\n`)).toBe(true);
  });

  it("missing file: result starts with the literal header followed by a blank line", async () => {
    const result = await composeLastMessagesSection("/nonexistent/path-xyz.jsonl", 3);
    expect(result.startsWith(`${HEADER}\n\n`)).toBe(true);
  });
});

describe("composeLastMessagesSection — N rendering", () => {
  it(">= N messages: returns last N in chronological order, blockquoted, separated by ---", async () => {
    const lines = [
      textAssistantLine("a"),
      textAssistantLine("b"),
      textAssistantLine("c"),
      textAssistantLine("d"),
      textAssistantLine("e"),
    ];
    const path = writeTmpFile("five.jsonl", lines.join("\n"));
    const result = await composeLastMessagesSection(path, 3);
    expect(result).toBe(`${HEADER}\n\n> c\n\n---\n\n> d\n\n---\n\n> e`);
  });

  it("< N messages: renders all available, no padding", async () => {
    const lines = [textAssistantLine("first"), textAssistantLine("second")];
    const path = writeTmpFile("two.jsonl", lines.join("\n"));
    const result = await composeLastMessagesSection(path, 10);
    expect(result).toBe(`${HEADER}\n\n> first\n\n---\n\n> second`);
  });
});

describe("composeLastMessagesSection — empty / missing → placeholder, no throw", () => {
  it("empty file (0 bytes) renders the placeholder", async () => {
    const path = writeTmpFile("empty.jsonl", "");
    await expect(composeLastMessagesSection(path, 5)).resolves.toBe(`${HEADER}\n\n${PLACEHOLDER}`);
  });

  it("missing path renders the placeholder and does not throw", async () => {
    await expect(composeLastMessagesSection("/nonexistent/path-xyz.jsonl", 5)).resolves.toBe(
      `${HEADER}\n\n${PLACEHOLDER}`,
    );
  });

  it("file with only non-assistant envelopes renders the placeholder", async () => {
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
    ];
    const path = writeTmpFile("non-assistant.jsonl", lines.join("\n"));
    await expect(composeLastMessagesSection(path, 5)).resolves.toBe(`${HEADER}\n\n${PLACEHOLDER}`);
  });
});

describe("composeLastMessagesSection — multi-line turn", () => {
  it("renders each line of a turn with a > prefix; blank lines render as bare >", async () => {
    const text = "line one\nline two\n\nparagraph two";
    const path = writeTmpFile("multiline.jsonl", textAssistantLine(text));
    const result = await composeLastMessagesSection(path, 5);
    expect(result).toBe(`${HEADER}\n\n> line one\n> line two\n>\n> paragraph two`);
  });
});

describe("composeLastMessagesSection — no escaping", () => {
  it("fenced code blocks survive verbatim inside the blockquote", async () => {
    const text = "```ts\nconst x = 1;\n```";
    const path = writeTmpFile("fenced.jsonl", textAssistantLine(text));
    const result = await composeLastMessagesSection(path, 5);
    expect(result).toBe(`${HEADER}\n\n> \`\`\`ts\n> const x = 1;\n> \`\`\``);
  });

  it("a --- line within a turn renders as > --- (a quoted line, not a horizontal rule)", async () => {
    const path = writeTmpFile("dashes.jsonl", textAssistantLine("---"));
    const result = await composeLastMessagesSection(path, 5);
    expect(result).toBe(`${HEADER}\n\n> ---`);
  });
});

describe("composeLastMessagesSection — n === 0", () => {
  it("renders the placeholder when n === 0 even if assistant messages exist", async () => {
    const lines = [
      textAssistantLine("first"),
      textAssistantLine("middle"),
      textAssistantLine("last"),
    ];
    const path = writeTmpFile("zero.jsonl", lines.join("\n"));
    await expect(composeLastMessagesSection(path, 0)).resolves.toBe(`${HEADER}\n\n${PLACEHOLDER}`);
  });
});
