import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, parseConfig } from "../../src/config/env.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALID_ENV_FIXTURE = join(__dirname, "fixtures", ".env.valid");

const TOKEN_CANARY = "sk-canary-token-do-not-leak";

function validEnv(): Record<string, string | undefined> {
  return {
    GITHUB_OWNER: "pyrycode",
    GITHUB_REPO: "agent-dispatcher-v2",
    PROJECT_NUMBER: "7",
    GITHUB_TOKEN: TOKEN_CANARY,
  };
}

describe("parseConfig", () => {
  it("happy path returns every field with parsed values and defaults", () => {
    const cfg = parseConfig({
      GITHUB_OWNER: "pyrycode",
      GITHUB_REPO: "agent-dispatcher-v2",
      PROJECT_NUMBER: "7",
      GITHUB_TOKEN: TOKEN_CANARY,
      OWNER_TYPE: "organization",
      TARGET_REPO_PATH: "/work/target",
      TARGET_DEFAULT_BRANCH: "trunk",
      SALVAGE_GATES: "pnpm typecheck;pnpm test",
      PYRY_MAX_CONCURRENT: "5",
      DISCORD_WEBHOOK_URL: "https://example/webhook",
      PYRY_LOG_RETENTION_DAYS: "14",
    });
    expect(cfg.githubOwner).toBe("pyrycode");
    expect(cfg.githubRepo).toBe("agent-dispatcher-v2");
    expect(cfg.projectNumber).toBe(7);
    expect(cfg.githubToken).toBe(TOKEN_CANARY);
    expect(cfg.ownerType).toBe("organization");
    expect(cfg.targetRepoPath).toBe("/work/target");
    expect(cfg.targetDefaultBranch).toBe("trunk");
    expect(cfg.salvageGates).toEqual(["pnpm typecheck", "pnpm test"]);
    expect(cfg.pyryMaxConcurrent).toBe(5);
    expect(cfg.discordWebhookUrl).toBe("https://example/webhook");
    expect(cfg.pyryLogRetentionDays).toBe(14);
  });

  it("applies defaults when optional vars are unset", () => {
    const cfg = parseConfig(validEnv());
    expect(cfg.ownerType).toBe("user");
    expect(cfg.targetRepoPath).toBeUndefined();
    expect(cfg.targetDefaultBranch).toBe("main");
    expect(cfg.salvageGates).toEqual([]);
    expect(cfg.pyryMaxConcurrent).toBe(2);
    expect(cfg.discordWebhookUrl).toBeUndefined();
    expect(cfg.pyryLogRetentionDays).toBe(30);
  });

  describe("required vars", () => {
    for (const key of ["GITHUB_OWNER", "GITHUB_REPO", "PROJECT_NUMBER", "GITHUB_TOKEN"] as const) {
      it(`throws naming ${key} when missing`, () => {
        const env = validEnv();
        env[key] = undefined;
        expect(() => parseConfig(env)).toThrow(new RegExp(`Missing required env var: ${key}`));
      });

      it(`throws naming ${key} when empty string`, () => {
        const env = validEnv();
        env[key] = "";
        expect(() => parseConfig(env)).toThrow(new RegExp(`Missing required env var: ${key}`));
      });
    }
  });

  describe("PROJECT_NUMBER", () => {
    it("rejects non-integer string", () => {
      expect(() => parseConfig({ ...validEnv(), PROJECT_NUMBER: "abc" })).toThrow(
        /Invalid PROJECT_NUMBER: expected integer/,
      );
    });

    it("rejects 0 (must be >= 1)", () => {
      expect(() => parseConfig({ ...validEnv(), PROJECT_NUMBER: "0" })).toThrow(
        /Invalid PROJECT_NUMBER: must be >= 1/,
      );
    });

    it("rejects decimals", () => {
      expect(() => parseConfig({ ...validEnv(), PROJECT_NUMBER: "1.5" })).toThrow(
        /Invalid PROJECT_NUMBER: expected integer/,
      );
    });

    it("rejects whitespace-padded values (strict parsing)", () => {
      expect(() => parseConfig({ ...validEnv(), PROJECT_NUMBER: " 1 " })).toThrow(
        /Invalid PROJECT_NUMBER: expected integer/,
      );
    });
  });

  describe("OWNER_TYPE", () => {
    it("accepts user", () => {
      expect(parseConfig({ ...validEnv(), OWNER_TYPE: "user" }).ownerType).toBe("user");
    });

    it("accepts organization", () => {
      expect(parseConfig({ ...validEnv(), OWNER_TYPE: "organization" }).ownerType).toBe(
        "organization",
      );
    });

    it("rejects mis-cased value (case-sensitive)", () => {
      expect(() => parseConfig({ ...validEnv(), OWNER_TYPE: "User" })).toThrow(
        /Invalid OWNER_TYPE/,
      );
    });

    it("rejects typos", () => {
      expect(() => parseConfig({ ...validEnv(), OWNER_TYPE: "orgnization" })).toThrow(
        /Invalid OWNER_TYPE/,
      );
    });

    it("defaults to user when unset", () => {
      expect(parseConfig(validEnv()).ownerType).toBe("user");
    });
  });

  describe("TARGET_REPO_PATH", () => {
    it("returns the string when set", () => {
      expect(parseConfig({ ...validEnv(), TARGET_REPO_PATH: "/work/x" }).targetRepoPath).toBe(
        "/work/x",
      );
    });

    it("returns undefined when unset", () => {
      expect(parseConfig(validEnv()).targetRepoPath).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(parseConfig({ ...validEnv(), TARGET_REPO_PATH: "" }).targetRepoPath).toBeUndefined();
    });
  });

  describe("TARGET_DEFAULT_BRANCH", () => {
    it("returns the string when set", () => {
      expect(
        parseConfig({ ...validEnv(), TARGET_DEFAULT_BRANCH: "develop" }).targetDefaultBranch,
      ).toBe("develop");
    });

    it("defaults to main when unset", () => {
      expect(parseConfig(validEnv()).targetDefaultBranch).toBe("main");
    });
  });

  describe("SALVAGE_GATES", () => {
    it("splits a;b;c into three gates", () => {
      expect(parseConfig({ ...validEnv(), SALVAGE_GATES: "a;b;c" }).salvageGates).toEqual([
        "a",
        "b",
        "c",
      ]);
    });

    it("trims whitespace around each gate", () => {
      expect(parseConfig({ ...validEnv(), SALVAGE_GATES: "a; b ; c" }).salvageGates).toEqual([
        "a",
        "b",
        "c",
      ]);
    });

    it("drops empty entries from consecutive separators", () => {
      expect(parseConfig({ ...validEnv(), SALVAGE_GATES: "a;;b" }).salvageGates).toEqual([
        "a",
        "b",
      ]);
    });

    it("empty string yields empty array", () => {
      expect(parseConfig({ ...validEnv(), SALVAGE_GATES: "" }).salvageGates).toEqual([]);
    });

    it("unset yields empty array (default)", () => {
      expect(parseConfig(validEnv()).salvageGates).toEqual([]);
    });
  });

  describe("PYRY_MAX_CONCURRENT", () => {
    it("accepts a positive integer", () => {
      expect(parseConfig({ ...validEnv(), PYRY_MAX_CONCURRENT: "3" }).pyryMaxConcurrent).toBe(3);
    });

    it("defaults to 2 when unset", () => {
      expect(parseConfig(validEnv()).pyryMaxConcurrent).toBe(2);
    });

    it("rejects 0", () => {
      expect(() => parseConfig({ ...validEnv(), PYRY_MAX_CONCURRENT: "0" })).toThrow(
        /Invalid PYRY_MAX_CONCURRENT: must be >= 1/,
      );
    });

    it("rejects negative", () => {
      expect(() => parseConfig({ ...validEnv(), PYRY_MAX_CONCURRENT: "-1" })).toThrow(
        /Invalid PYRY_MAX_CONCURRENT: must be >= 1/,
      );
    });

    it("rejects non-integer", () => {
      expect(() => parseConfig({ ...validEnv(), PYRY_MAX_CONCURRENT: "abc" })).toThrow(
        /Invalid PYRY_MAX_CONCURRENT: expected integer/,
      );
    });
  });

  describe("DISCORD_WEBHOOK_URL", () => {
    it("returns the string when set (no URL-shape validation)", () => {
      expect(
        parseConfig({ ...validEnv(), DISCORD_WEBHOOK_URL: "anything-goes" }).discordWebhookUrl,
      ).toBe("anything-goes");
    });

    it("returns undefined when unset", () => {
      expect(parseConfig(validEnv()).discordWebhookUrl).toBeUndefined();
    });
  });

  describe("PYRY_LOG_RETENTION_DAYS", () => {
    it("accepts a positive integer", () => {
      expect(
        parseConfig({ ...validEnv(), PYRY_LOG_RETENTION_DAYS: "7" }).pyryLogRetentionDays,
      ).toBe(7);
    });

    it("accepts 0 (rotation disabled)", () => {
      expect(
        parseConfig({ ...validEnv(), PYRY_LOG_RETENTION_DAYS: "0" }).pyryLogRetentionDays,
      ).toBe(0);
    });

    it("defaults to 30 when unset", () => {
      expect(parseConfig(validEnv()).pyryLogRetentionDays).toBe(30);
    });

    it("rejects negative", () => {
      expect(() => parseConfig({ ...validEnv(), PYRY_LOG_RETENTION_DAYS: "-1" })).toThrow(
        /Invalid PYRY_LOG_RETENTION_DAYS: must be >= 0/,
      );
    });

    it("rejects non-integer", () => {
      expect(() => parseConfig({ ...validEnv(), PYRY_LOG_RETENTION_DAYS: "abc" })).toThrow(
        /Invalid PYRY_LOG_RETENTION_DAYS: expected integer/,
      );
    });
  });

  describe("token redaction (AC #5)", () => {
    // Lock in the contract: a thrown error never echoes the GITHUB_TOKEN value.
    // Run for every throw site that fires after GITHUB_TOKEN has been read.
    function expectNoTokenLeak(env: Record<string, string | undefined>) {
      try {
        parseConfig(env);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toContain(TOKEN_CANARY);
        return;
      }
      throw new Error("expected parseConfig to throw");
    }

    it("missing GITHUB_REPO does not leak the token", () => {
      const env = validEnv();
      env.GITHUB_REPO = undefined;
      expectNoTokenLeak(env);
    });

    it("invalid PROJECT_NUMBER does not leak the token", () => {
      expectNoTokenLeak({ ...validEnv(), PROJECT_NUMBER: "not-a-number" });
    });

    it("invalid OWNER_TYPE does not leak the token", () => {
      expectNoTokenLeak({ ...validEnv(), OWNER_TYPE: "person" });
    });

    it("invalid PYRY_MAX_CONCURRENT does not leak the token", () => {
      expectNoTokenLeak({ ...validEnv(), PYRY_MAX_CONCURRENT: "0" });
    });
  });

  describe("immutability", () => {
    it("returned config is frozen", () => {
      const cfg = parseConfig(validEnv());
      expect(Object.isFrozen(cfg)).toBe(true);
    });

    it("salvageGates array is frozen", () => {
      const cfg = parseConfig({ ...validEnv(), SALVAGE_GATES: "a;b" });
      expect(Object.isFrozen(cfg.salvageGates)).toBe(true);
    });

    it("assigning to a config field throws in strict mode", () => {
      const cfg = parseConfig(validEnv());
      expect(() => {
        (cfg as { githubOwner: string }).githubOwner = "x";
      }).toThrow();
    });
  });
});

describe("loadConfig", () => {
  let tmp: string;
  const SNAPSHOT_KEYS = [
    "GITHUB_OWNER",
    "GITHUB_REPO",
    "PROJECT_NUMBER",
    "GITHUB_TOKEN",
    "OWNER_TYPE",
    "TARGET_REPO_PATH",
    "TARGET_DEFAULT_BRANCH",
    "SALVAGE_GATES",
    "PYRY_MAX_CONCURRENT",
    "DISCORD_WEBHOOK_URL",
    "PYRY_LOG_RETENTION_DAYS",
  ] as const;

  beforeEach(() => {
    // Strip any developer-local values that would otherwise win over the .env file
    // (process.env overrides .env by design, so unstub-after isn't enough).
    for (const key of SNAPSHOT_KEYS) vi.stubEnv(key, "");
    tmp = mkdtempSync(join(tmpdir(), "env-config-test-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads <agentsRoot>/.env, parses it, and returns a frozen Config", () => {
    // Stage the canonical fixture as `<tmp>/.env` (loadConfig reads `.env` by name).
    copyFileSync(VALID_ENV_FIXTURE, join(tmp, ".env"));
    const cfg = loadConfig({ agentsRoot: tmp });
    expect(cfg.githubOwner).toBe("fixture-owner");
    expect(cfg.githubRepo).toBe("fixture-repo");
    expect(cfg.projectNumber).toBe(42);
    expect(cfg.githubToken).toBe("fixture-token-do-not-leak");
    expect(cfg.ownerType).toBe("organization");
    expect(cfg.salvageGates).toEqual(["pnpm typecheck", "pnpm test"]);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it("missing .env is not an error when process.env supplies required vars", () => {
    vi.stubEnv("GITHUB_OWNER", "from-process-env");
    vi.stubEnv("GITHUB_REPO", "agent-dispatcher-v2");
    vi.stubEnv("PROJECT_NUMBER", "1");
    vi.stubEnv("GITHUB_TOKEN", "tok");
    const cfg = loadConfig({ agentsRoot: tmp });
    expect(cfg.githubOwner).toBe("from-process-env");
  });

  it("process.env wins over .env (override convention)", () => {
    writeFileSync(
      join(tmp, ".env"),
      [
        "GITHUB_OWNER=from-env-file",
        "GITHUB_REPO=agent-dispatcher-v2",
        "PROJECT_NUMBER=1",
        "GITHUB_TOKEN=tok",
      ].join("\n"),
    );
    vi.stubEnv("GITHUB_OWNER", "from-process-env");
    const cfg = loadConfig({ agentsRoot: tmp });
    expect(cfg.githubOwner).toBe("from-process-env");
  });
});
