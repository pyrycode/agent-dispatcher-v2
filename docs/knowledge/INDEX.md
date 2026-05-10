# Knowledge index

One-line summaries. Add an entry whenever a new doc lands under `features/`, `decisions/`, or `architecture/`.

## Features

- [CI workflow](features/ci-workflow.md) — GitHub Actions enforcement of the four scaffold checks (install / typecheck / test / lint) on PRs to `main` and pushes to `main`.

## Decisions

- [ADR 0001 — pnpm version pinned in workflow YAML](decisions/0001-pnpm-version-in-workflow.md) — pnpm major pinned in CI, not in `package.json`. Reasoning behind the choice and the cleaner follow-up.
- [ADR 0002 — `SALVAGE_GATES` defaults to empty](decisions/0002-salvage-gates-default-empty.md) — salvage is opt-in; no consumer-stack assumption baked into the dispatcher's default.

## Architecture

*(none yet — first `src/` ticket will seed `architecture/system-overview.md`)*

## Per-ticket implementation summaries

See [`codebase/`](codebase/) — one file per ticket. The directory listing is the index.
