# Spec: Verify scaffold toolchain + add CI workflow (#1)

## Files to read first

- `package.json` — `engines.node` (`>=22`), scripts (`typecheck`, `test`, `lint`), absence of `packageManager` field
- `pnpm-lock.yaml:1-4` — `lockfileVersion: '9.0'` (the only existing pnpm-version signal)
- `biome.json` — confirms `biome check src test` is the lint command (matches `pnpm lint`)
- `vitest.config.ts` — confirms `pnpm test` runs `vitest run` headlessly
- `test/scaffold.test.ts` — the single existing test the workflow must keep green
- `src/index.ts` — the file the AC's "noop PR" will touch (one-line comment tweak)
- `CLAUDE.md` § "Architectural rules" — confirms this ticket only adds CI plumbing; no `src/` work

## Context

The scaffold (`pyrycode/agent-dispatcher-v2`) is committed and runs green locally. AC requires GitHub Actions to enforce the same four checks (`pnpm install`, `pnpm typecheck`, `pnpm test`, `biome check`) on every PR to `main` and every push to `main`, so subsequent tickets land with CI signal from day one.

Out of scope: any `src/` module work.

## Design

### One file: `.github/workflows/ci.yml`

Single job, single OS (`ubuntu-latest`), single Node version. No matrix — this is a private TS package with one supported runtime.

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

# Cancel stale runs on the same PR/branch — saves CI minutes on rapid pushes.
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # pnpm BEFORE setup-node so setup-node's pnpm cache resolver works.
      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version-file: 'package.json'  # reads engines.node (>=22 → latest 22.x)
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm lint  # = biome check src test (per package.json)
```

### Step ordering and exact commands

The AC enumerates: `pnpm install`, `pnpm typecheck`, `pnpm test`, `biome check`. The workflow runs:

1. `pnpm install --frozen-lockfile` — `--frozen-lockfile` is the standard CI guard against silent lockfile drift; it's not a new version pin, just enforcement of the existing lockfile.
2. `pnpm typecheck` — `tsc --noEmit`
3. `pnpm test` — `vitest run`
4. `pnpm lint` — `biome check src test` (the AC's "biome check"; using the pnpm script keeps CI commands identical to what local devs run)

Each step is its own `- run:` so failures surface with named step boundaries in the GitHub UI. Do not chain with `&&`.

### Version pinning — what's declared and what isn't

The technical note says "Pin Node and pnpm to whatever the repo's `package.json` / `.nvmrc` / `packageManager` field already declare; do not introduce new version pins in this ticket."

Current state:

| Tool | Where declared | Resolves to |
|------|----------------|-------------|
| Node | `package.json#engines.node` = `>=22` | latest 22.x at runtime |
| pnpm | **nothing explicit** — only `pnpm-lock.yaml#lockfileVersion: '9.0'` | requires choosing |

**Node:** use `actions/setup-node@v4` with `node-version-file: 'package.json'`. setup-node reads `engines.node` from there. No new pin introduced.

**pnpm:** there is no `packageManager` field and no `.nvmrc`-equivalent for pnpm in the repo. The lockfile version `9.0` is consumed by both pnpm 9 and pnpm 10, so it doesn't uniquely pin a major. The minimal-impact choice is `version: 9` in the workflow YAML, matching the lockfile-major. This is a CI-only constraint; it does not modify `package.json`.

A cleaner long-term answer is adding `"packageManager": "pnpm@9.x.y"` to `package.json` so local dev and CI share one source of truth — but that introduces a new explicit pin, which the technical note forbids in this ticket. Leave it as a follow-up. See **Open questions**.

### Why pnpm/action-setup before setup-node

`actions/setup-node`'s `cache: 'pnpm'` option resolves the pnpm store path by invoking the pnpm binary. The binary must already be on `PATH`, so pnpm/action-setup runs first. Reversing the order yields a "pnpm: command not found" failure during cache key resolution.

### Concurrency + permissions

- `concurrency` block cancels superseded runs on the same ref. Standard pattern; saves minutes on rapid PR pushes.
- `permissions: contents: read` — least-privilege default. CI doesn't need to write commits, comments, or releases for this workflow. If a later ticket adds e.g. PR-comment publishing, that ticket can grant the specific scope it needs.

### The noop-PR validation

AC #4 requires a noop PR producing a green end-to-end run. Implementation: edit a single comment in `src/index.ts` (e.g. add a trailing period or rephrase the existing comment), open a PR, observe the four steps pass.

The developer should treat this as a manual verification step performed *after* the workflow file lands on `main` — not as an automated test. The result is observed, not committed back. Document the verification in the PR description (or a follow-up comment) showing the green CI run URL.

## Files touched

- `.github/workflows/ci.yml` — new, ~35 lines
- *(no `src/` changes — the noop edit for AC #4 is a separate validation PR after merge)*

## Testing strategy

CI itself is the test. There is no unit test for a workflow file. The acceptance gate is:

1. Workflow file present and YAML-valid (`yamllint` is not in scope; rely on GitHub Actions parser).
2. After merge, open a noop PR (one-character comment tweak in `src/index.ts`) and confirm all four steps green.
3. Confirm the workflow also runs on the merge-to-main push (push trigger).

## Open questions

- **pnpm pin location.** Spec recommends `version: 9` in workflow YAML, treating "introduce no new pins" literally (no edits to `package.json`). If maintainers prefer `packageManager: "pnpm@9.15.0"` in `package.json` as the source of truth (with `pnpm/action-setup` reading it via no `version:` arg), file a follow-up ticket. Both are correct; the difference is cosmetic.
- **Lint step name.** Workflow uses `pnpm lint`; AC text says `biome check`. They run the same command (`biome check src test`). If the maintainer wants the literal AC string, change to `- run: pnpm exec biome check src test`. Spec recommends keeping `pnpm lint` so local and CI commands match exactly.
- **Caching of node_modules vs pnpm store.** `cache: 'pnpm'` on `actions/setup-node` caches the pnpm content-addressable store, not `node_modules`. This is the recommended pattern (faster + smaller cache surface). No action needed; flagging in case a future ticket wants a different strategy.

## Out of scope (explicit non-goals)

- Multi-OS or multi-Node-version matrix (this is an internal Node-22-only TS package).
- Coverage reporting, codecov upload, artifact upload — none requested.
- Auto-merge / auto-label workflows — separate concern.
- Branch protection rules requiring this check — repo-admin task, not a workflow change.
- Dependabot / Renovate config — separate ticket.
