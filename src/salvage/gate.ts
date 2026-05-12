// Pure decision module for the safe-salvage gate. The subprocess runner is
// injected (GateRunner) so this file has no child_process import — per
// CLAUDE.md § "Pure functions in src/pipeline/, I/O at the edges", the
// decision stays pure and the spawning lives at the salvage orchestrator's
// edge. Separators are `,` and `;` (interchangeable); whitespace is trimmed
// around each command and empty segments are discarded. shouldAttemptSafeSalvage
// short-circuits on the first non-zero exit; operators can order the env-var
// to put the cheapest gate first.

export type GateRunner = (cmd: string) => Promise<number>;

export function parseSalvageGates(raw: string | undefined): readonly string[] {
  if (raw === undefined) return Object.freeze([]);
  const segments = raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Object.freeze(segments);
}

export async function shouldAttemptSafeSalvage(
  gates: string | undefined,
  run: GateRunner,
): Promise<boolean> {
  const cmds = parseSalvageGates(gates);
  if (cmds.length === 0) return false;
  for (const cmd of cmds) {
    const code = await run(cmd);
    if (code !== 0) return false;
  }
  return true;
}
