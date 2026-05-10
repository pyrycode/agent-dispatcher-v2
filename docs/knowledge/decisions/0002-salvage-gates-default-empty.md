# ADR 0002 — `SALVAGE_GATES` defaults to empty (salvage opt-in)

## Context

Ticket #3 lands `src/config/env.ts`, the dispatcher's typed configuration loader. One optional var, `SALVAGE_GATES`, is a `;`-delimited list of shell commands the dispatcher runs to verify a salvageable PR before merging.

v1 (pyrycode/pyrycode) defaulted to `["go vet ./...", "go build ./..."]` because v1 dispatched against a single Go target repo. v2 dispatches against arbitrary target repos — agents-repo `.env` is the per-consumer configuration; the target stack is whatever `TARGET_REPO_PATH` points at. The Go-toolchain default no longer applies.

PO's tech notes flagged the choice as unresolved. Two options were on the table:

1. **Default to a Node-toolchain pair** (e.g. `["pnpm typecheck", "pnpm test"]`) — matches the stack of this very repo, looks helpful for Node consumers.
2. **Default to `[]`** — salvage is opt-in; consumers declare gates explicitly in `.env`.

## Decision

Default `SALVAGE_GATES` to `[]`. Salvage is opt-in.

## Rationale

The dispatcher does not know the target repo's stack. Picking *any* non-empty default bakes in a stack assumption:

- `["pnpm typecheck", "pnpm test"]` is a regression for any Go consumer (e.g. the original `pyrycode/pyrycode` repo). The first salvage attempt would run `pnpm` in a Go tree and fail with a confusing "command not found" rather than a useful gate result.
- Inverting (defaulting to Go gates) is a regression for every Node consumer.
- There is no neutral non-empty default. Anything cross-stack would have to shell out to a tool that doesn't exist by convention, which means the default is always wrong somewhere.

The empty default is the only choice that doesn't make a consumer-stack assumption. Each consumer's `.env` declares the gates appropriate to its target — exactly the layer where stack knowledge already lives (`TARGET_REPO_PATH`, `TARGET_DEFAULT_BRANCH`).

## Consequences

- Salvage runs no gates by default. A consumer that wants salvage must set `SALVAGE_GATES` explicitly. This is the right friction: "are you sure this PR is salvage-mergeable?" deserves a deliberate answer per consumer.
- The salvage module (not yet written) MUST treat an empty gate list as "no gates configured" and decide its own policy — likely "salvage disabled" rather than "salvage with zero gates means everything passes." Document this when the salvage module lands; without that, the empty default could be misread as "salvage everything unconditionally."
- A future ticket may want a small `pyry init` UX that scaffolds an `.env` with a stack-appropriate gate suggestion. That's a launcher-level concern, not a config-loader default.

## Alternatives considered

- **Sniff the target's package manager and pick a default.** Rejected: introduces I/O and target-repo coupling into a leaf config module that has neither today. Sniffing also fails ambiguously for polyglot repos.
- **Require the var (no default).** Rejected: makes salvage configuration mandatory even for consumers who never use the salvage path. Optional + empty default keeps the simpler usage simple.
