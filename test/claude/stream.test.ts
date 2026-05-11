import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseStream } from "../../src/claude/stream.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "fixtures", "claude-stream");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

describe("parseStream — success fixture", () => {
  const raw = loadFixture("success.jsonl");

  it("routes to exitReason 'success'", () => {
    expect(parseStream(raw).exitReason).toBe("success");
  });

  it("captures the session_id from the init message", () => {
    expect(parseStream(raw).sessionId).toBe("28b6666c-9bb6-4212-a5d7-8c34588e6f8a");
  });

  it("captures total_cost_usd from the result message", () => {
    expect(parseStream(raw).totalCostUsd).toBe(0.17967025);
  });

  it("captures the last assistant text block as lastAssistantMessage", () => {
    expect(parseStream(raw).lastAssistantMessage).toBe("PARSER");
  });

  it("captures the same text in lastNAssistantMessages (length 1)", () => {
    const r = parseStream(raw);
    expect(r.lastNAssistantMessages).toEqual(["PARSER"]);
  });

  it("lastAssistantMessage equals the final entry of lastNAssistantMessages", () => {
    const r = parseStream(raw);
    const arr = r.lastNAssistantMessages;
    expect(r.lastAssistantMessage).toBe(arr[arr.length - 1]);
  });
});

describe("parseStream — max_turns fixture", () => {
  const raw = loadFixture("max_turns.jsonl");

  it("routes to exitReason 'max_turns'", () => {
    expect(parseStream(raw).exitReason).toBe("max_turns");
  });

  it("captures sessionId (init message reached before the wall)", () => {
    expect(parseStream(raw).sessionId).toBe("58d209f8-ef20-4c00-87cd-a0a0b735e204");
  });

  it("captures a positive total_cost_usd", () => {
    expect(parseStream(raw).totalCostUsd).toBeGreaterThan(0);
  });

  it("captures the assistant text emitted before the wall", () => {
    expect(parseStream(raw).lastAssistantMessage).toBe(
      "Acknowledging the task and running the requested command.",
    );
  });
});

describe("parseStream — rate_limit fixture", () => {
  const raw = loadFixture("rate_limit.jsonl");

  it("routes to exitReason 'rate_limit'", () => {
    expect(parseStream(raw).exitReason).toBe("rate_limit");
  });

  it("captures sessionId from the verbatim init line", () => {
    expect(parseStream(raw).sessionId).toBe("28b6666c-9bb6-4212-a5d7-8c34588e6f8a");
  });

  it("skips the // SYNTHESIZED FIXTURE marker without throwing", () => {
    expect(() => parseStream(raw)).not.toThrow();
  });
});

describe("parseStream — error fixture (unrecognized subtype)", () => {
  const raw = loadFixture("error.jsonl");

  it("routes unmapped subtype to exitReason 'error' (does not throw)", () => {
    expect(parseStream(raw).exitReason).toBe("error");
  });

  it("still captures sessionId and totalCostUsd", () => {
    const r = parseStream(raw);
    expect(r.sessionId).toBe("28b6666c-9bb6-4212-a5d7-8c34588e6f8a");
    expect(r.totalCostUsd).toBe(0.001234);
  });
});

describe("parseStream — empty / malformed input", () => {
  it("empty string returns the all-defaults error result", () => {
    const r = parseStream("");
    expect(r.exitReason).toBe("error");
    expect(r.sessionId).toBeUndefined();
    expect(r.totalCostUsd).toBe(0);
    expect(r.lastAssistantMessage).toBeUndefined();
    expect(r.lastNAssistantMessages).toEqual([]);
  });

  it("a single malformed line is skipped and yields the same result as empty", () => {
    const r = parseStream("{not-json");
    expect(r.exitReason).toBe("error");
    expect(r.sessionId).toBeUndefined();
  });

  it("trailing partial JSON is skipped while complete prior lines parse", () => {
    const init = '{"type":"system","subtype":"init","session_id":"abc-123"}';
    const partial = '{"type":"resul';
    const r = parseStream(`${init}\n${partial}`);
    expect(r.sessionId).toBe("abc-123");
    expect(r.exitReason).toBe("error");
    expect(r.totalCostUsd).toBe(0);
  });

  it("blank lines and \\r\\n line endings are tolerated", () => {
    const init = '{"type":"system","subtype":"init","session_id":"abc-123"}';
    const result =
      '{"type":"result","subtype":"success","session_id":"abc-123","total_cost_usd":0.5,"result":"hi"}';
    const r = parseStream(`\r\n${init}\r\n\r\n${result}\r\n`);
    expect(r.exitReason).toBe("success");
    expect(r.sessionId).toBe("abc-123");
    expect(r.totalCostUsd).toBe(0.5);
  });
});

describe("parseStream — lastN behaviour", () => {
  function assistantLine(text: string): string {
    return JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    });
  }

  it("respects the lastN parameter (keeps the most recent N, drops older)", () => {
    const lines = [
      '{"type":"system","subtype":"init","session_id":"s1"}',
      assistantLine("m1"),
      assistantLine("m2"),
      assistantLine("m3"),
      assistantLine("m4"),
      assistantLine("m5"),
      assistantLine("m6"),
      assistantLine("m7"),
    ].join("\n");
    const r = parseStream(lines, { lastN: 3 });
    expect(r.lastNAssistantMessages).toEqual(["m5", "m6", "m7"]);
  });

  it("preserves chronological order (oldest first within the slice)", () => {
    const lines = [assistantLine("first"), assistantLine("middle"), assistantLine("last")].join(
      "\n",
    );
    const r = parseStream(lines, { lastN: 5 });
    expect(r.lastNAssistantMessages).toEqual(["first", "middle", "last"]);
    expect(r.lastAssistantMessage).toBe("last");
  });

  it("defaults to lastN=5 when opts is omitted", () => {
    const lines = [
      assistantLine("a"),
      assistantLine("b"),
      assistantLine("c"),
      assistantLine("d"),
      assistantLine("e"),
      assistantLine("f"),
      assistantLine("g"),
    ].join("\n");
    const r = parseStream(lines);
    expect(r.lastNAssistantMessages).toEqual(["c", "d", "e", "f", "g"]);
  });

  it("excludes tool_use and tool_result blocks from lastNAssistantMessages", () => {
    const mixed = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "before tool" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          { type: "thinking", thinking: "..." },
          { type: "text", text: "after tool" },
        ],
      },
    });
    const r = parseStream(mixed);
    expect(r.lastNAssistantMessages).toEqual(["before tool", "after tool"]);
    expect(r.lastAssistantMessage).toBe("after tool");
  });
});

describe("parseStream — exit reason fallback signals", () => {
  it("routes a result with terminal_reason='max_turns' even if subtype is unrecognized", () => {
    const init = '{"type":"system","subtype":"init","session_id":"s"}';
    const result = JSON.stringify({
      type: "result",
      subtype: "error_other",
      session_id: "s",
      terminal_reason: "max_turns",
    });
    expect(parseStream(`${init}\n${result}`).exitReason).toBe("max_turns");
  });

  it("routes via /rate.?limit/i in the result text when no subtype/terminal_reason matches", () => {
    const init = '{"type":"system","subtype":"init","session_id":"s"}';
    const result = JSON.stringify({
      type: "result",
      subtype: "error_other",
      session_id: "s",
      result: "API request failed: rate-limit exceeded, retry after 60s",
    });
    expect(parseStream(`${init}\n${result}`).exitReason).toBe("rate_limit");
  });
});

describe("parseStream — result struct immutability", () => {
  it("the returned struct is frozen", () => {
    const r = parseStream("");
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("the lastNAssistantMessages array is frozen", () => {
    const r = parseStream(loadFixture("success.jsonl"));
    expect(Object.isFrozen(r.lastNAssistantMessages)).toBe(true);
  });
});
