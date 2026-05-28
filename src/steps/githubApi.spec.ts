import { describe, it, expect, vi } from "vitest";
import {
  runGithubApi,
  GithubApiInputSchema,
  GithubActionType,
  type GithubAction,
  type GithubTransport,
  type GithubTransportResult,
} from "./githubApi";

// ---------------------------------------------------------------------------
// Tests for the github_api step executor. The executor takes a structured
// list of GitHub actions (post review, post inline comment, resolve thread,
// add label, etc.) and runs them serially through an injected transport.
// Per-action 429 backoff with a 60s cap; non-rate-limit failures are
// recorded in the per-action result and the batch continues.
//
// Vision §4.3 documents the rationale for batching all of one Claude
// step's GitHub actions into a single executor call: it bounds the
// step's concurrency footprint to one global GitHub-API slot regardless
// of how many sub-actions it makes, preventing the 429-storm problem
// the daemon was designed to avoid.
// ---------------------------------------------------------------------------

function makeAction(overrides: Partial<GithubAction> = {}): GithubAction {
  return {
    type: GithubActionType.AddLabel,
    params: { repo: "owner/repo", pr: 1, label: "x" },
    ...overrides,
  } as GithubAction;
}

interface ScriptedResponse {
  match?: (action: GithubAction) => boolean;
  result: GithubTransportResult;
}

function makeFakeTransport(script: ScriptedResponse[]): {
  transport: GithubTransport;
  calls: GithubAction[];
} {
  const calls: GithubAction[] = [];
  let i = 0;
  const transport: GithubTransport = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async call(action: GithubAction): Promise<GithubTransportResult> {
      calls.push(action);
      // Find first scripted response that matches (or is unconstrained).
      while (i < script.length) {
        const entry = script[i]!;
        if (entry.match === undefined || entry.match(action)) {
          i++;
          return entry.result;
        }
        i++;
      }
      throw new Error(
        `fake transport ran out of scripted responses at call ${String(calls.length)}`,
      );
    },
  };
  return { transport, calls };
}

const noSleep = vi.fn<(ms: number) => Promise<void>>(async () => {
  await Promise.resolve();
});

describe("Input schema rejects unknown action types at workflow-load time", () => {
  it("rejects an action whose type is not in the closed enum", () => {
    expect(() =>
      GithubApiInputSchema.parse({
        actions: [{ type: "summon_dragon", params: {} }],
      }),
    ).toThrow();
  });

  it("accepts a valid input with multiple known action types", () => {
    const parsed = GithubApiInputSchema.parse({
      actions: [
        {
          type: "post_review",
          params: {
            repo: "owner/repo",
            pr: 1,
            verdict: "approved",
            body: "ok",
          },
        },
        {
          type: "add_label",
          params: { repo: "owner/repo", pr: 1, label: "approved" },
        },
      ],
    });
    expect(parsed.actions).toHaveLength(2);
    expect(parsed.actions[0]?.type).toBe(GithubActionType.PostReview);
  });
});

describe("Sub-actions execute serially in the order provided", () => {
  it("calls the transport once per action, preserving order", async () => {
    const a1 = makeAction({
      params: { repo: "owner/repo", pr: 1, label: "a" },
    });
    const a2 = makeAction({
      params: { repo: "owner/repo", pr: 1, label: "b" },
    });
    const a3 = makeAction({
      params: { repo: "owner/repo", pr: 1, label: "c" },
    });
    const { transport, calls } = makeFakeTransport([
      { result: { kind: "ok", data: {} } },
      { result: { kind: "ok", data: {} } },
      { result: { kind: "ok", data: {} } },
    ]);
    const out = await runGithubApi(
      { actions: [a1, a2, a3] },
      { transport, sleep: noSleep },
    );
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => (c.params as { label: string }).label)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(out.results).toHaveLength(3);
    expect(out.partial_failure).toBe(false);
  });

  it("returns empty results for an empty action list", async () => {
    const { transport, calls } = makeFakeTransport([]);
    const out = await runGithubApi(
      { actions: [] },
      { transport, sleep: noSleep },
    );
    expect(calls).toHaveLength(0);
    expect(out.results).toHaveLength(0);
    expect(out.partial_failure).toBe(false);
  });
});

describe("On 429 / secondary rate limit the executor backs off and retries the same sub-action", () => {
  it("retries after a 429, succeeds on the second attempt", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const { transport, calls } = makeFakeTransport([
      { result: { kind: "rate_limited" } },
      { result: { kind: "ok", data: { id: "ok" } } },
    ]);
    const out = await runGithubApi(
      { actions: [makeAction()] },
      { transport, sleep },
    );
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(out.partial_failure).toBe(false);
    expect(out.results[0]?.outcome).toBe("ok");
  });

  it("uses exponential backoff capped at 60_000 ms", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const { transport } = makeFakeTransport([
      { result: { kind: "rate_limited" } },
      { result: { kind: "rate_limited" } },
      { result: { kind: "rate_limited" } },
      { result: { kind: "rate_limited" } },
      { result: { kind: "rate_limited" } },
      { result: { kind: "rate_limited" } },
      { result: { kind: "rate_limited" } },
      { result: { kind: "ok", data: {} } },
    ]);
    await runGithubApi(
      { actions: [makeAction()] },
      {
        transport,
        sleep,
        initialBackoffMs: 1000,
        maxBackoffMs: 60000,
        maxRetries: 7,
      },
    );
    // 7 sleeps before the eventual success.
    expect(sleep).toHaveBeenCalledTimes(7);
    const sleepMs = sleep.mock.calls.map((c) => c[0]);
    // Each call must be at least the prior call (monotonic) and capped at 60_000.
    expect(Math.max(...sleepMs)).toBeLessThanOrEqual(60000);
    expect(sleepMs[0]).toBe(1000);
    expect(sleepMs[1]).toBe(2000);
    expect(sleepMs[2]).toBe(4000);
    expect(sleepMs[3]).toBe(8000);
    expect(sleepMs[4]).toBe(16000);
    expect(sleepMs[5]).toBe(32000);
    expect(sleepMs[6]).toBe(60000); // capped
  });

  it("gives up after maxRetries and records the action as failed without aborting the batch", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const { transport } = makeFakeTransport([
      { result: { kind: "rate_limited" } },
      { result: { kind: "rate_limited" } },
      { result: { kind: "rate_limited" } },
      { result: { kind: "rate_limited" } },
      // Second action succeeds — batch should continue.
      { result: { kind: "ok", data: {} } },
    ]);
    const out = await runGithubApi(
      { actions: [makeAction(), makeAction()] },
      { transport, sleep, maxRetries: 3 },
    );
    expect(out.results).toHaveLength(2);
    expect(out.results[0]?.outcome).toBe("rate_limited");
    expect(out.results[1]?.outcome).toBe("ok");
    expect(out.partial_failure).toBe(true);
  });
});

describe("Non-rate-limit failure of one sub-action records the failure and continues the batch", () => {
  it("records a non-retriable error and proceeds with the next action", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const { transport, calls } = makeFakeTransport([
      {
        result: {
          kind: "error",
          message: "not found",
          retriable: false,
        },
      },
      { result: { kind: "ok", data: {} } },
    ]);
    const out = await runGithubApi(
      { actions: [makeAction(), makeAction()] },
      { transport, sleep },
    );
    expect(calls).toHaveLength(2);
    expect(out.results[0]?.outcome).toBe("failed");
    expect(out.results[0]?.error).toContain("not found");
    expect(out.results[1]?.outcome).toBe("ok");
    expect(out.partial_failure).toBe(true);
  });

  it("does NOT retry on a non-retriable error", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const { transport, calls } = makeFakeTransport([
      {
        result: {
          kind: "error",
          message: "permission denied",
          retriable: false,
        },
      },
    ]);
    const out = await runGithubApi(
      { actions: [makeAction()] },
      { transport, sleep, maxRetries: 5 },
    );
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(out.partial_failure).toBe(true);
  });
});

describe("Per-action results include the action type and index for downstream routing", () => {
  it("records each result with its original action type and index", async () => {
    const a1 = makeAction({
      type: GithubActionType.PostReview,
      params: {
        repo: "owner/repo",
        pr: 1,
        verdict: "approved",
        body: "ok",
      },
    });
    const a2 = makeAction({
      type: GithubActionType.AddLabel,
      params: { repo: "owner/repo", pr: 1, label: "approved" },
    });
    const { transport } = makeFakeTransport([
      { result: { kind: "ok", data: { reviewId: "R_123" } } },
      { result: { kind: "ok", data: {} } },
    ]);
    const out = await runGithubApi(
      { actions: [a1, a2] },
      { transport, sleep: noSleep },
    );
    expect(out.results[0]?.actionType).toBe(GithubActionType.PostReview);
    expect(out.results[0]?.index).toBe(0);
    expect(out.results[1]?.actionType).toBe(GithubActionType.AddLabel);
    expect(out.results[1]?.index).toBe(1);
  });
});
