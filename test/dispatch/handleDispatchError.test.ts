import { describe, expect, it } from "vitest";
import {
  DISPATCH_ERROR_LABEL,
  type DispatchErrorLogger,
  handleDispatchError,
} from "../../src/dispatch/handleDispatchError.ts";
import type { DispatchState } from "../../src/dispatch/state.ts";

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

function fakeLogger(behavior?: { onError?: () => void }) {
  const calls: Array<{
    err: unknown;
    context: { issueNumber: number; agent: string; phase: "dispatch" };
  }> = [];
  const logger: DispatchErrorLogger = {
    error(err, context) {
      calls.push({ err, context: { ...context } });
      if (behavior?.onError) behavior.onError();
    },
  };
  return { calls, logger };
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

describe("handleDispatchError", () => {
  it("happy path: applies error:dispatch label and logs the caught error once", async () => {
    const labels = fakeLabels();
    const logger = fakeLogger();
    const state = makeState();
    const original = new Error("boom");

    const result = await handleDispatchError(original, state, {
      labels: labels.client,
      logger: logger.logger,
    });

    expect(result).toBeUndefined();
    expect(labels.calls).toEqual([{ number: 88, name: "error:dispatch" }]);
    expect(logger.calls.length).toBe(1);
    const first = logger.calls[0];
    if (!first) throw new Error("expected one logger call");
    expect(first.err).toBe(original);
    expect(first.context).toEqual({
      issueNumber: 88,
      agent: "developer",
      phase: "dispatch",
    });
  });

  it("addLabel throws → does NOT rethrow; original + label-add errors both logged in order", async () => {
    const labels = fakeLabels({
      onAdd: () => {
        throw new Error("HTTP 500");
      },
    });
    const logger = fakeLogger();
    const state = makeState();
    const original = new Error("dispatch failure");

    await expect(
      handleDispatchError(original, state, {
        labels: labels.client,
        logger: logger.logger,
      }),
    ).resolves.toBeUndefined();

    expect(logger.calls.length).toBe(2);
    const first = logger.calls[0];
    const second = logger.calls[1];
    if (!first || !second) throw new Error("expected two logger calls");
    expect(first.err).toBe(original);
    expect(second.err).toBeInstanceOf(Error);
    expect((second.err as Error).message).toBe("HTTP 500");
  });

  it("load-bearing ordering: logger fires before addLabel on the happy path", async () => {
    const events: string[] = [];
    const labels = fakeLabels({
      onAdd: () => {
        events.push("label");
      },
    });
    const logger = fakeLogger({
      onError: () => {
        events.push("log");
      },
    });

    await handleDispatchError(new Error("x"), makeState(), {
      labels: labels.client,
      logger: logger.logger,
    });

    expect(events).toEqual(["log", "label"]);
  });

  it("exports DISPATCH_ERROR_LABEL as the literal 'error:dispatch'", () => {
    expect(DISPATCH_ERROR_LABEL).toBe("error:dispatch");
  });
});
