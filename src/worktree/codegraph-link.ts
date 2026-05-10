// Decide + apply the canonical `.codegraph/` symlink for a fresh worktree.
// `decideCodegraphSymlink` is pure (state in, action list out);
// `applyCodegraphSymlinkActions` walks the list against a narrow `SymlinkFs`
// seam. Production wiring passes `node:fs/promises` directly.
//
// What this does NOT decide: which worktree to link, when to link it,
// how to probe state (the dispatch-layer integration's concern), pruning
// out-of-band-broken targets (out of scope until observed).
//
// Load-bearing invariant per CLAUDE.md "Belt-and-suspenders": granting the
// codegraph MCP server in `allowedTools` is necessary but not sufficient —
// without this symlink, the agent silently falls back to file-by-file
// reading and the failure is invisible from the dispatcher's side. This
// module is the deterministic safety net behind that agent-side rule.

import { posix as path } from "node:path";

// Pre-computed by the caller (a future probe helper inspects fs state and
// classifies into one of these). Per the #6 narrow-types rule, only the
// fields the predicate reads are present — no fs.Stats, no error chains,
// no actualLinkTarget on branches that don't need it.
export type CodegraphLinkState =
  | { readonly kind: "absent" }
  | { readonly kind: "present-correct" }
  | { readonly kind: "present-wrong-target"; readonly currentTarget: string }
  | { readonly kind: "target-missing" };

// Named noop reasons — callers branch on these without re-deriving the
// state. AC #3 explicitly calls out the named-constant shape for
// `target-missing`; applying it to `present-correct` too is the consistent
// shape.
export const NOOP_TARGET_MISSING = "target-missing";
export const NOOP_ALREADY_CORRECT = "already-correct";

export interface SymlinkAction {
  readonly kind: "create" | "repair" | "noop";
  readonly from: string; // canonical .codegraph (link target)
  readonly to: string; // <worktreeRoot>/.codegraph (link path)
  readonly reason?: string;
}

export interface DecideCodegraphSymlinkInput {
  readonly worktreeRoot: string;
  readonly targetCodegraphPath: string;
  readonly state: CodegraphLinkState;
}

// Pure. The exhaustive `switch` over `state.kind` is the union-closure
// assertion — a future fifth state is a TS error rather than a silent
// missing row, mirroring `shouldProduceCommits` in pipeline/blockers.ts.
export function decideCodegraphSymlink(input: DecideCodegraphSymlinkInput): SymlinkAction[] {
  const to = path.join(input.worktreeRoot, ".codegraph");
  const from = input.targetCodegraphPath;
  switch (input.state.kind) {
    case "target-missing":
      return [{ kind: "noop", from, to, reason: NOOP_TARGET_MISSING }];
    case "absent":
      return [{ kind: "create", from, to }];
    case "present-correct":
      return [{ kind: "noop", from, to, reason: NOOP_ALREADY_CORRECT }];
    case "present-wrong-target":
      return [{ kind: "repair", from, to }];
  }
}

// DI seam — narrow shape with the two operations the applier needs. Method
// names match `node:fs/promises` so production wiring is a free pass-through.
export interface SymlinkFs {
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export async function applyCodegraphSymlinkActions(
  actions: readonly SymlinkAction[],
  fs: SymlinkFs,
): Promise<void> {
  for (const action of actions) {
    if (action.kind === "noop") continue;
    if (action.kind === "repair") await fs.unlink(action.to);
    await fs.symlink(action.from, action.to);
  }
}
