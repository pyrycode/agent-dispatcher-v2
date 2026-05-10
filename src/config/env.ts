import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Single source of truth for dispatcher environment configuration.
//
// `parseConfig` is pure: it takes a raw env record (string | undefined values)
// and returns a frozen, validated `Config`. All branch tests target it directly.
//
// `loadConfig` is the thin I/O wrapper: read `<agentsRoot>/.env`, layer
// process.env on top, hand the merged record to `parseConfig`.
//
// AGENTS_REPO_PATH is intentionally NOT consumed here — the launcher reads it
// via `paths/agents-root.ts` to locate the .env file before this runs. Putting
// it in .env would be a chicken-and-egg loop.
//
// Empty-string env values are treated as unset everywhere (matches `paths/`'s
// convention; guards against stray `KEY=` lines in .env and explicit
// `KEY=""` exports in the launcher's shell).

export interface Config {
  readonly githubOwner: string;
  readonly githubRepo: string;
  readonly projectNumber: number;
  readonly githubToken: string;
  readonly ownerType: "user" | "organization";
  readonly targetRepoPath: string | undefined;
  readonly targetDefaultBranch: string;
  readonly salvageGates: readonly string[];
  readonly pyryMaxConcurrent: number;
  readonly discordWebhookUrl: string | undefined;
  readonly pyryLogRetentionDays: number;
}

export interface LoadConfigOpts {
  agentsRoot: string;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const githubOwner = requireVar(env, "GITHUB_OWNER");
  const githubRepo = requireVar(env, "GITHUB_REPO");
  const projectNumber = parseIntegerVar(requireVar(env, "PROJECT_NUMBER"), "PROJECT_NUMBER", {
    min: 1,
  });
  const githubToken = requireVar(env, "GITHUB_TOKEN");

  const ownerTypeRaw = readVar(env, "OWNER_TYPE");
  const ownerType: "user" | "organization" = (() => {
    if (ownerTypeRaw === undefined) return "user";
    if (ownerTypeRaw === "user" || ownerTypeRaw === "organization") return ownerTypeRaw;
    throw new Error(`Invalid OWNER_TYPE: expected "user" or "organization", got "${ownerTypeRaw}"`);
  })();

  const targetRepoPath = readVar(env, "TARGET_REPO_PATH");
  const targetDefaultBranch = readVar(env, "TARGET_DEFAULT_BRANCH") ?? "main";

  const salvageGatesRaw = readVar(env, "SALVAGE_GATES");
  const salvageGates: readonly string[] = Object.freeze(
    salvageGatesRaw === undefined
      ? []
      : salvageGatesRaw
          .split(";")
          .map((gate) => gate.trim())
          .filter((gate) => gate.length > 0),
  );

  const pyryMaxConcurrentRaw = readVar(env, "PYRY_MAX_CONCURRENT");
  const pyryMaxConcurrent =
    pyryMaxConcurrentRaw === undefined
      ? 2
      : parseIntegerVar(pyryMaxConcurrentRaw, "PYRY_MAX_CONCURRENT", { min: 1 });

  const discordWebhookUrl = readVar(env, "DISCORD_WEBHOOK_URL");

  const pyryLogRetentionDaysRaw = readVar(env, "PYRY_LOG_RETENTION_DAYS");
  const pyryLogRetentionDays =
    pyryLogRetentionDaysRaw === undefined
      ? 30
      : parseIntegerVar(pyryLogRetentionDaysRaw, "PYRY_LOG_RETENTION_DAYS", { min: 0 });

  return Object.freeze({
    githubOwner,
    githubRepo,
    projectNumber,
    githubToken,
    ownerType,
    targetRepoPath,
    targetDefaultBranch,
    salvageGates,
    pyryMaxConcurrent,
    discordWebhookUrl,
    pyryLogRetentionDays,
  });
}

export function loadConfig(opts: LoadConfigOpts): Config {
  const envFilePath = resolve(opts.agentsRoot, ".env");
  const fileEnv = existsSync(envFilePath) ? readEnvFile(envFilePath) : {};
  // process.env wins over .env (CI / test harness can inject overrides), but
  // empty-string values in process.env do NOT override — consistent with the
  // module-wide "empty = unset" rule. Without the filter, `vi.stubEnv(key, "")`
  // in tests (and explicit `KEY=""` in a launcher shell) would silently nuke
  // values present in .env, which is never the intent.
  const processEnvNonEmpty: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value.length > 0) processEnvNonEmpty[key] = value;
  }
  return parseConfig({ ...fileEnv, ...processEnvNonEmpty });
}

function readVar(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function requireVar(env: Record<string, string | undefined>, key: string): string {
  const v = readVar(env, key);
  if (v === undefined) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function parseIntegerVar(raw: string, key: string, opts: { min: number }): number {
  // Strict: digits with optional leading `-`. Reject "1.0", "1abc", " 1 ".
  // Use a string-name guard so a future "validate token shape" temptation
  // can't leak GITHUB_TOKEN's value through this helper's error message.
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Invalid ${key}: expected integer, got "${raw}"`);
  }
  const n = Number.parseInt(raw, 10);
  if (n < opts.min) {
    throw new Error(`Invalid ${key}: must be >= ${opts.min}, got ${n}`);
  }
  return n;
}

// Tiny line-based .env reader. Handles comments, blank lines, and a single
// surrounding pair of double or single quotes. Does NOT handle: backslash
// escapes, multi-line values, ${VAR} interpolation, or trailing inline
// comments (so `KEY=value # comment` reads value as `"value # comment"`).
// v1 didn't need any of these; escalate if a future ticket does.
function readEnvFile(path: string): Record<string, string> {
  const text = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== "") out[key] = value;
  }
  return out;
}
