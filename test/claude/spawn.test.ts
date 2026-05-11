import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ClaudeRunner,
  SPAWN_ENV_DENYLIST,
  scrubSpawnEnv,
  spawnClaude,
} from "../../src/claude/spawn.ts";
import { parseStream } from "../../src/claude/stream.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "..", "fixtures", "claude-stream");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

const EXPECTED_DENYLIST = [
  "DISCORD_WEBHOOK_URL",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "GITHUB_TOKEN",
  "PROJECT_NUMBER",
  "PYRY_MAX_CONCURRENT",
  "TARGET_REPO_PATH",
];

describe("SPAWN_ENV_DENYLIST — exact contents pin", () => {
  it("contains exactly the seven dispatcher-internal variables (sorted)", () => {
    expect(Array.from(SPAWN_ENV_DENYLIST).sort()).toEqual(EXPECTED_DENYLIST);
  });
});

describe("scrubSpawnEnv", () => {
  it("removes denylisted keys and preserves the rest", () => {
    const input: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: "secret",
      PATH: "/usr/bin",
      HOME: "/h",
      PYRY_MAX_CONCURRENT: "2",
      FOO: "bar",
    };
    const result = scrubSpawnEnv(input);
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/h");
    expect(result.FOO).toBe("bar");
    expect("GITHUB_TOKEN" in result).toBe(false);
    expect("PYRY_MAX_CONCURRENT" in result).toBe(false);
  });

  it("does not mutate the input object", () => {
    const input: NodeJS.ProcessEnv = { GITHUB_TOKEN: "secret", PATH: "/usr/bin" };
    scrubSpawnEnv(input);
    expect("GITHUB_TOKEN" in input).toBe(true);
    expect(input.GITHUB_TOKEN).toBe("secret");
  });

  it("strips every entry in SPAWN_ENV_DENYLIST", () => {
    const input: NodeJS.ProcessEnv = { KEEP_ME: "yes" };
    for (const key of SPAWN_ENV_DENYLIST) {
      input[key] = `sentinel-${key}`;
    }
    const result = scrubSpawnEnv(input);
    expect(result.KEEP_ME).toBe("yes");
    for (const key of SPAWN_ENV_DENYLIST) {
      expect(key in result).toBe(false);
    }
  });
});

describe("spawnClaude", () => {
  function captureRunner(stdout = ""): {
    runner: ClaudeRunner;
    calls: { cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv }[];
  } {
    const calls: { cmd: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const runner: ClaudeRunner = async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return { stdout, exitCode: 0 };
    };
    return { runner, calls };
  }

  it("passes a scrubbed env to the runner", async () => {
    const { runner, calls } = captureRunner();
    await spawnClaude([], { GITHUB_TOKEN: "secret", PATH: "/usr/bin" }, { runner });
    const env = calls[0]?.env ?? {};
    expect("GITHUB_TOKEN" in env).toBe(false);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("prepends -p --output-format stream-json to the supplied args", async () => {
    const { runner, calls } = captureRunner();
    await spawnClaude(["--model", "opus", "--max-turns", "10"], {}, { runner });
    expect(calls[0]?.cmd).toBe("claude");
    expect(calls[0]?.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--model",
      "opus",
      "--max-turns",
      "10",
    ]);
  });

  it("returns parseStream(stdout) for the success fixture", async () => {
    const fixture = loadFixture("success.jsonl");
    const { runner } = captureRunner(fixture);
    const result = await spawnClaude([], {}, { runner });
    expect(result).toEqual(parseStream(fixture));
  });

  it("threads lastN through to parseStream", async () => {
    const fixture = loadFixture("success.jsonl");
    const { runner } = captureRunner(fixture);
    const result = await spawnClaude([], {}, { runner, lastN: 1 });
    expect(result).toEqual(parseStream(fixture, { lastN: 1 }));
  });

  it("propagates runner rejection to the caller", async () => {
    const runner: ClaudeRunner = async () => {
      throw new Error("ENOENT");
    };
    await expect(spawnClaude([], {}, { runner })).rejects.toThrow("ENOENT");
  });
});
