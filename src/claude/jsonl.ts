// Reads Claude's on-disk session JSONL and returns the last N assistant text
// messages, oldest-first. Used by salvage to populate the "Last messages from
// the agent" section of a max_turns recovery PR.
//
// I/O edge: this module calls fs.readFile. The parse step is intentionally
// duplicated rather than shared with src/claude/stream.ts — the two surfaces
// consume different wire formats (session JSONL vs stream-json stdout), and
// keeping the parsers independent prevents wire-format drift on one side from
// silently propagating to the other. See spec § "Reuse" for rationale.

import { readFile } from "node:fs/promises";

type Msg = Record<string, unknown>;

export async function extractLastMessages(jsonlPath: string, n: number): Promise<string[]> {
  const raw = await readFile(jsonlPath, "utf8");
  const texts: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Partial / malformed line (e.g. writer killed mid-write). Skip silently
      // — mirrors stream.ts's posture.
      continue;
    }
    if (!isObject(parsed)) continue;
    if (parsed.type !== "assistant") continue;
    for (const text of extractAssistantText(parsed)) {
      texts.push(text);
    }
  }

  if (n <= 0) return [];
  return texts.slice(-n);
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
