import { describe, expect, it } from "vitest";
import { cleanupAfterDispatch } from "../../src/dispatch/cleanupAfterDispatch.ts";
import type { DispatchState } from "../../src/dispatch/state.ts";
import type { Agent } from "../../src/pipeline/selection.ts";

function fakeLabels(behavior?: {
  onRemove?: (n: number, name: string) => void | Promise<void>;
}) {
  const calls: Array<{ number: number; name: string }> = [];
  const removeLabel = async (number: number, name: string): Promise<void> => {
    calls.push({ number, name });
    if (behavior?.onRemove) await behavior.onRemove(number, name);
  };
  return { calls, client: { removeLabel } };
}

function makeState(overrides?: Partial<DispatchState>): DispatchState {
  return {
    agent: "developer",
    issueNumber: 89,
    worktreePath: "/tmp/wt",
    args: [],
    ...overrides,
  };
}

describe("cleanupAfterDispatch", () => {
  it("happy path: removes wip:<agent> on the issue and resolves void", async () => {
    const labels = fakeLabels();
    const state = makeState({ agent: "architect", issueNumber: 87 });

    const result = await cleanupAfterDispatch(state, { labels: labels.client });

    expect(result).toBeUndefined();
    expect(labels.calls).toEqual([{ number: 87, name: "wip:architect" }]);
  });

  it("idempotent: issues exactly one removeLabel call without a pre-check", async () => {
    // The fake's removeLabel resolves cleanly without throwing — mirroring
    // how the real client behaves when the label is already absent (GET
    // shows it missing, no PUT issued, returns void). The wrapper must not
    // add its own existence check before calling removeLabel.
    const labels = fakeLabels();
    const state = makeState();

    const result = await cleanupAfterDispatch(state, { labels: labels.client });

    expect(result).toBeUndefined();
    expect(labels.calls).toHaveLength(1);
    expect(labels.calls[0]).toEqual({ number: 89, name: "wip:developer" });
  });

  it("per-agent label naming: every Agent value yields wip:<agent>", async () => {
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
      await cleanupAfterDispatch(state, { labels: labels.client });
      expect(labels.calls).toEqual([{ number: 1, name: `wip:${agent}` }]);
    }
  });

  it("removeLabel rejection propagates to the caller", async () => {
    const labels = fakeLabels({
      onRemove: () => {
        throw new Error("HTTP 500");
      },
    });
    const state = makeState();

    await expect(cleanupAfterDispatch(state, { labels: labels.client })).rejects.toThrow(
      "HTTP 500",
    );
  });
});
