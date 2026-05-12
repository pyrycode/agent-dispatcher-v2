import { describe, expect, it } from "vitest";
import type { CreatePrInput } from "../../src/github/pr.ts";
import {
  type OpenSalvageDraftPrInput,
  SALVAGE_LABEL,
  openSalvageDraftPr,
} from "../../src/salvage/draft-pr.ts";

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

function fakePr(behavior?: {
  onCreate?: (input: CreatePrInput) => void | Promise<void>;
  number?: number;
}) {
  const calls: CreatePrInput[] = [];
  const createPr = async (input: CreatePrInput) => {
    calls.push(input);
    if (behavior?.onCreate) await behavior.onCreate(input);
    const n = behavior?.number ?? 42;
    return {
      number: n,
      nodeId: "PR_kw1",
      url: `https://github.com/pyrycode/v2/pull/${n}`,
    };
  };
  return { calls, client: { createPr } };
}

function makeInput(overrides?: Partial<OpenSalvageDraftPrInput>): OpenSalvageDraftPrInput {
  return {
    issueNumber: 71,
    title: "[salvage] feature/71",
    body: "**Last messages from the agent:**\n\n> hello",
    head: "feature/71",
    base: "main",
    ...overrides,
  };
}

describe("openSalvageDraftPr", () => {
  it("happy path: returns PR number; label applied to issue; PR created as draft with exact wire shape", async () => {
    const labels = fakeLabels();
    const pr = fakePr({ number: 137 });
    const input = makeInput();

    const result = await openSalvageDraftPr({ labels: labels.client, pr: pr.client }, input);

    expect(result).toBe(137);
    expect(labels.calls).toEqual([{ number: 71, name: "error:max_turns_salvaged" }]);
    expect(pr.calls.length).toBe(1);
    expect(pr.calls[0]).toEqual({
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: true,
    });
  });

  it("load-bearing ordering: addLabel is invoked before createPr (no parallel/reordered execution)", async () => {
    const events: string[] = [];
    const labels = fakeLabels({
      onAdd: () => {
        events.push("label");
      },
    });
    const pr = fakePr({
      onCreate: () => {
        events.push("create");
      },
    });

    await openSalvageDraftPr({ labels: labels.client, pr: pr.client }, makeInput());

    expect(events).toEqual(["label", "create"]);
  });

  // This test pins AC bullet 3 AND AC bullet 5 (no try/catch swallowing).
  // If a future refactor wraps addLabel in try/catch, the rethrow assertion
  // below fails — no separate test needed for the swallowing property.
  it("addLabel throws → createPr never invoked; the throw rethrows verbatim", async () => {
    const labels = fakeLabels({
      onAdd: () => {
        throw new Error("HTTP 500: label failed");
      },
    });
    const pr = fakePr();

    await expect(
      openSalvageDraftPr({ labels: labels.client, pr: pr.client }, makeInput()),
    ).rejects.toThrow("HTTP 500: label failed");

    expect(labels.calls.length).toBe(1);
    expect(pr.calls.length).toBe(0);
  });

  it("createPr throws after addLabel succeeded → rethrows; label call still happened (recoverable state)", async () => {
    const labels = fakeLabels();
    const pr = fakePr({
      onCreate: () => {
        throw new Error("HTTP 500: pr failed");
      },
    });

    await expect(
      openSalvageDraftPr({ labels: labels.client, pr: pr.client }, makeInput()),
    ).rejects.toThrow("HTTP 500: pr failed");

    expect(labels.calls.length).toBe(1);
    expect(labels.calls[0]).toEqual({ number: 71, name: "error:max_turns_salvaged" });
  });

  it("exports SALVAGE_LABEL as the literal string used at the call site", () => {
    expect(SALVAGE_LABEL).toBe("error:max_turns_salvaged");
  });
});
