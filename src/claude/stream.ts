// Pure parser for `claude -p --output-format stream-json` output.
//
// The CLI emits one JSON object per line over the lifetime of a run. This
// module extracts the five fields downstream code (src/loop/, src/salvage/,
// telemetry) needs: total cost, sessionId, the last assistant message, the
// last N assistant messages, and a closed-set exit-reason discriminant.
//
// Pure: no await, no gh / git / fs reads. The caller (future src/loop/) is
// responsible for running the subprocess and buffering its stdout — this
// function takes that buffer as a string and returns a frozen result struct.
// Malformed lines are skipped silently; the I/O caller logs raw lines if it
// cares. See CLAUDE.md "Pure functions in src/pipeline/, I/O at the edges"
// — placement under src/claude/ follows directory semantics (Claude-specific
// I/O format) even though the function itself is pure.

export type ExitReason = "success" | "max_turns" | "rate_limit" | "error";

export interface ParseStreamOpts {
  readonly lastN?: number;
}

export interface StreamParseResult {
  readonly totalCostUsd: number;
  readonly sessionId: string | undefined;
  readonly lastAssistantMessage: string | undefined;
  readonly lastNAssistantMessages: readonly string[];
  readonly exitReason: ExitReason;
}

const DEFAULT_LAST_N = 5;

type Msg = Record<string, unknown>;

export function parseStream(raw: string, opts?: ParseStreamOpts): StreamParseResult {
  const lastN = opts?.lastN ?? DEFAULT_LAST_N;

  const assistantTexts: string[] = [];
  let sessionId: string | undefined;
  let resultMsg: Msg | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Partial / malformed line (e.g. timeout-killed mid-write). Skip — the
      // caller is responsible for raw-line logging if it wants it.
      continue;
    }
    if (!isObject(parsed)) continue;
    const msg = parsed;
    const type = msg.type;

    if (type === "system") {
      if (msg.subtype === "init" && sessionId === undefined && typeof msg.session_id === "string") {
        sessionId = msg.session_id;
      }
    } else if (type === "assistant") {
      for (const text of extractAssistantText(msg)) {
        assistantTexts.push(text);
      }
    } else if (type === "result") {
      // Last result message wins; the CLI emits at most one per run.
      resultMsg = msg;
    }
  }

  const totalCostUsd =
    resultMsg && typeof resultMsg.total_cost_usd === "number" ? resultMsg.total_cost_usd : 0;
  if (sessionId === undefined && resultMsg && typeof resultMsg.session_id === "string") {
    sessionId = resultMsg.session_id;
  }
  const slice = assistantTexts.slice(-Math.max(0, lastN));
  const lastNAssistantMessages = Object.freeze(slice);
  const lastAssistantMessage = slice.length > 0 ? slice[slice.length - 1] : undefined;
  const exitReason = mapExitReason(resultMsg);

  return Object.freeze({
    totalCostUsd,
    sessionId,
    lastAssistantMessage,
    lastNAssistantMessages,
    exitReason,
  });
}

function mapExitReason(resultMsg: Msg | null): ExitReason {
  if (!resultMsg) return "error";
  const subtype = typeof resultMsg.subtype === "string" ? resultMsg.subtype : "";
  const terminalReason =
    typeof resultMsg.terminal_reason === "string" ? resultMsg.terminal_reason : "";

  if (subtype === "success") return "success";
  if (subtype === "error_max_turns" || terminalReason === "max_turns") return "max_turns";
  if (
    subtype === "error_rate_limit" ||
    terminalReason === "rate_limit" ||
    /rate.?limit/i.test(typeof resultMsg.result === "string" ? resultMsg.result : "")
  ) {
    return "rate_limit";
  }
  return "error";
}

function extractAssistantText(msg: Msg): string[] {
  const message = msg.message;
  if (!isObject(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (
      isObject(block) &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.length > 0
    ) {
      out.push(block.text);
    }
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
