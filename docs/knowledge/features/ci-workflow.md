# CI workflow

GitHub Actions workflow at `.github/workflows/ci.yml` enforces the scaffold's four checks on every PR to `main` and every push to `main`.

## What it runs

| Step | Command | Purpose |
|------|---------|---------|
| 1 | `pnpm install --frozen-lockfile` | Install with strict lockfile guard |
| 2 | `pnpm typecheck` | `tsc --noEmit` |
| 3 | `pnpm test` | `vitest run` |
| 4 | `pnpm lint` | `biome check src test` |

Each step is its own `- run:` so failures surface as named step boundaries in the GitHub UI. Do not chain with `&&`.

## Triggers

- `pull_request` targeting `main`
- `push` to `main`

## Versioning

- **Node** comes from `package.json#engines.node` (`>=22`) via `actions/setup-node@v4`'s `node-version-file: 'package.json'`. No duplicate pin in the workflow.
- **pnpm** is pinned to `version: 9` directly in the workflow YAML. The repo has no `packageManager` field; the lockfile alone doesn't uniquely resolve pnpm's major. Workflow-local `version: 9` is the minimal CI-only constraint.

## Operational notes

- **Step order matters.** `pnpm/action-setup@v4` runs before `actions/setup-node@v4`. setup-node's `cache: 'pnpm'` invokes the pnpm binary to resolve the store path, so pnpm must already be on `PATH`.
- **Concurrency.** Runs on the same ref are cancelled when a new commit lands (`cancel-in-progress: true`). Saves CI minutes on rapid PR pushes.
- **Least privilege.** `permissions: contents: read` only. Workflows that need write scopes (PR comments, releases) declare them locally.
- **Cache.** `cache: 'pnpm'` on setup-node caches the pnpm content-addressable store, not `node_modules`.

## Adding a new check

If a future ticket adds a check (e.g. coverage), add it as a new `- run:` step after lint. Don't bundle into an existing step. Don't introduce a matrix unless multi-OS or multi-Node testing becomes a requirement.

## Related

- [ADR 0001 — pnpm version pinned in workflow YAML](../decisions/0001-pnpm-version-in-workflow.md)
- [Codebase entry — #1](../codebase/1.md)
