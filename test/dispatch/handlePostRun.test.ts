import { describe, expect, it } from "vitest";
import { handlePostRun } from "../../src/dispatch/handlePostRun.ts";
import type { DispatchState } from "../../src/dispatch/state.ts";
import type { Agent } from "../../src/pipeline/selection.ts";

function fakeLabels(behavior?: {
  onAdd?: (n: number, name: string) => void | Promise<void>;
}) {
  const calls: Array<{ number: number; name: string }> = [];
  const addLabel = async (number: number, name: string): Promise<void> => {
    calls.push({ number, name });
    if (behavior?.onAdd) await behavior.onAdd(number, name);
  };
  return { calls, client: { addLabel } };
}

function makeState(overrides?: Partial<DispatchState>): DispatchState {
  return {
    agent: "developer",
    issueNumber: 88,
    worktreePath: "/tmp/wt",
    args: [],
    ...overrides,
  };
}

describe("handlePostRun", () => {
  it("happy path: applies ready:<agent> on the issue and resolves void", async () => {
    const labels = fakeLabels();
    const state = makeState({ agent: "architect", issueNumber: 87 });

    const result = await handlePostRun(state, { labels: labels.client });

    expect(result).toBeUndefined();
    expect(labels.calls).toEqual([{ number: 87, name: "ready:architect" }]);
  });

  it("per-agent label naming: every Agent value yields ready:<agent>", async () => {
    const agents: readonly Agent[] = [
      "po",
      "architect",
      "developer",
      "code-review",
      "documentation",
    ];

    for (const agent of agents) {
      const labels = fakeLabels();
      const state = makeState({ agent, issueNumber: 1 });
      await handlePostRun(state, { labels: labels.client });
      expect(labels.calls).toEqual([{ number: 1, name: `ready:${agent}` }]);
    }
  });

  it("addLabel rejection propagates to the caller", async () => {
    const labels = fakeLabels({
      onAdd: () => {
        throw new Error("HTTP 500");
      },
    });
    const state = makeState();

    await expect(handlePostRun(state, { labels: labels.client })).rejects.toThrow("HTTP 500");
  });
});
