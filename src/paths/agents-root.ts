import { resolve } from "node:path";

// Pure resolver for the agents-repo root. Caller reads process.env and supplies
// `envValue` plus an optional `fallback`; this module performs no I/O.
//
// No launcher-relative fallback is derived here. v1 used a `__dirname + "../.."`
// offset because dispatcher source lived inside each consumer's `agents/dispatch/src/`
// tree; v2 source ships from its own repo and has no fixed positional relationship
// to any consumer's `agents/`. The dispatch-bin call site requires AGENTS_REPO_PATH
// to be set; the `fallback` parameter stays so tests can exercise the second branch
// and so a future caller can derive one without changing the resolver.
//
// Empty-string env is treated as unset (a stray `AGENTS_REPO_PATH=` line in `.env`
// reads as `""`, not `undefined`).

export interface ResolveAgentsRootOpts {
  envValue: string | undefined;
  fallback: string | undefined;
}

export function resolveAgentsRoot(opts: ResolveAgentsRootOpts): string {
  if (typeof opts.envValue === "string" && opts.envValue.length > 0) {
    return resolve(opts.envValue);
  }
  if (typeof opts.fallback === "string" && opts.fallback.length > 0) {
    return resolve(opts.fallback);
  }
  throw new Error("Cannot resolve agents repo root: set AGENTS_REPO_PATH or pass a fallback path");
}
