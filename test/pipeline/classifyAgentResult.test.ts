import { describe, expect, it } from "vitest";
import type { ExitReason, StreamParseResult } from "../../src/claude/stream.ts";
import { classifyAgentResult } from "../../src/pipeline/classifyAgentResult.ts";

function fakeResult(exitReason: ExitReason): StreamParseResult {
  return {
    totalCostUsd: 0,
    sessionId: undefined,
    lastAssistantMessage: undefined,
    lastNAssistantMessages: [],
    exitReason,
  };
}

describe("classifyAgentResult — happy path", () => {
  it("maps success to ok", () => {
    expect(classifyAgentResult(fakeResult("success"))).toBe("ok");
  });
});

describe("classifyAgentResult — agent-error path", () => {
  it.each(["max_turns", "rate_limit", "error"] as const)("maps %s to agent-error", (exitReason) => {
    expect(classifyAgentResult(fakeResult(exitReason))).toBe("agent-error");
  });
});
