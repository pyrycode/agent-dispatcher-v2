# Lessons

Gotchas surfaced during implementation. Append-only; don't rewrite history.

## CI / GitHub Actions

### `pnpm/action-setup` must run before `actions/setup-node` (#1)

`actions/setup-node@v4`'s `cache: 'pnpm'` resolves the pnpm content-addressable store path by invoking the `pnpm` binary. The binary needs to be on `PATH`, so `pnpm/action-setup@v4` MUST run first. Reversing the order yields "pnpm: command not found" during cache key resolution — not a typecheck/test failure, a setup failure, which is easy to misread.

### pnpm lockfile version doesn't uniquely pin pnpm major (#1)

`pnpm-lock.yaml#lockfileVersion: '9.0'` is consumed by both pnpm 9 and pnpm 10. Reading it does not tell you which major to install in CI. If neither `package.json#packageManager` nor a workflow-local `version:` is set, the action picks an unpredictable default. Pin explicitly somewhere.

### `--frozen-lockfile` in CI, plain `pnpm install` locally (#1)

`--frozen-lockfile` is the standard CI guard against silent lockfile drift — it's not a new version pin, just enforcement of the existing lockfile. Use it on every CI install step. Don't add it to local dev docs; devs need to be able to add deps without a CI flag fighting them.
