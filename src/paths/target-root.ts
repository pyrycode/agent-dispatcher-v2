import { resolve } from "node:path";

// Pure resolver for the target-repo root. Caller reads process.env and supplies
// `envValue` plus the previously-resolved `agentsRoot`; this module performs no I/O.
//
// agents/ lives INSIDE the target repo (not as a sibling), so the fallback is
// `parent-of(agentsRoot)`. The "sibling" framing was a v1 bug fixed in commit
// c72adb4; do not reintroduce it.
//
// Empty-string env is treated as unset.

export interface ResolveTargetRootOpts {
  envValue: string | undefined;
  agentsRoot: string | undefined;
}

export function resolveTargetRoot(opts: ResolveTargetRootOpts): string {
  if (typeof opts.envValue === "string" && opts.envValue.length > 0) {
    return resolve(opts.envValue);
  }
  if (typeof opts.agentsRoot === "string" && opts.agentsRoot.length > 0) {
    return resolve(opts.agentsRoot, "..");
  }
  throw new Error(
    "Cannot resolve target repo root: set TARGET_REPO_PATH or pass a non-empty agentsRoot",
  );
}
