// Composes the `**Last messages from the agent:**` section of a salvage PR
// body. Delegates JSONL parsing to src/claude/jsonl.ts (#61); this module owns
// only the Markdown shape and the missing-file → placeholder contract. The
// composer catches all extractor rejections (not just ENOENT) because, from
// the operator's vantage, "couldn't read the file" and "file was empty" are
// indistinguishable when reading the PR — and the salvage flow is itself a
// recovery surface, so an exception here would escalate a max_turns event
// into a dispatcher crash.

import { extractLastMessages } from "../claude/jsonl.ts";

const HEADER = "**Last messages from the agent:**";
const PLACEHOLDER = "_(no assistant messages captured)_";

export async function composeLastMessagesSection(jsonlPath: string, n: number): Promise<string> {
  let turns: string[];
  try {
    turns = await extractLastMessages(jsonlPath, n);
  } catch {
    turns = [];
  }
  const body = turns.map(renderTurn).join("\n\n---\n\n");
  return `${HEADER}\n\n${body || PLACEHOLDER}`;
}

function renderTurn(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}
