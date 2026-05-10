# ADR 0001 — pnpm version pinned in CI workflow YAML

## Context

Scaffold ticket #1 added GitHub Actions CI. The repo had no explicit pnpm version pin: no `packageManager` field in `package.json`, no `.nvmrc`-equivalent. Only `pnpm-lock.yaml#lockfileVersion: '9.0'` existed, and that lockfile version is consumed by both pnpm 9 and pnpm 10 — so it didn't uniquely pin a major.

CI needed *some* pnpm version. The ticket explicitly forbade introducing new version pins to `package.json`.

## Decision

Pin pnpm in the workflow YAML: `pnpm/action-setup@v4` with `version: 9`. No edits to `package.json`.

## Rationale

Two valid options:

1. **Workflow-local pin** (chosen): `version: 9` in `.github/workflows/ci.yml`. Minimal blast radius; CI-only constraint.
2. **`packageManager` field**: `"packageManager": "pnpm@9.x.y"` in `package.json`, single source of truth for local + CI.

Option 2 is cleaner long-term but introduces a new explicit pin to `package.json`, which the ticket forbade. Option 1 keeps the ticket scoped to CI plumbing.

## Consequences

- CI uses pnpm 9. Local devs using pnpm 10 may produce the same lockfile (it's `9.0` either way) but their commands run on a different major than CI.
- A follow-up ticket should add `packageManager` to `package.json` and drop the workflow-local `version:`. The action reads the field automatically when `version` is absent.
- Until that follow-up: any pnpm-major bump requires editing the workflow YAML, not `package.json`.
