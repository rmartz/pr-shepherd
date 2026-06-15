import { describe, it, expect, vi } from "vitest";
import { StepStatus, StepType, type StepInstance } from "@/db/schemas";
import {
  createWaitAuthorPushExecutor,
  DEFAULT_WAIT_AUTHOR_PUSH_POLL_INTERVAL_MS,
  DEFAULT_WAIT_AUTHOR_PUSH_TIMEOUT_MS,
} from "./waitAuthorPush";

function makeStep(input: Record<string, unknown>): StepInstance {
  return {
    id: "step-1",
    runId: "run-1",
    stepDefinitionId: "wait-author-push",
    stepType: StepType.WaitAuthorPush,
    status: StepStatus.Running,
    input,
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1,
    metrics: {
      claudeMs: 0,
      activeMs: 0,
      scheduleWaitMs: 0,
      externalWaitMs: 0,
    },
  };
}

describe("waitAuthorPush executor", () => {
  it("completes immediately when a new commit already exists", async () => {
    const listCommitDates = vi
      .fn<(pr: number) => Promise<string[]>>()
      .mockResolvedValue(["2026-01-01T00:00:10.000Z"]);
    const listCommitSummaries = vi
      .fn<(pr: number) => Promise<{ sha: string; committedDate: string }[]>>()
      .mockResolvedValue([
        { sha: "abc123", committedDate: "2026-01-01T00:00:10.000Z" },
      ]);
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const step = makeStep({
      pr: 42,
      sinceReviewSubmittedAt: "2026-01-01T00:00:00.000Z",
    });

    const exec = createWaitAuthorPushExecutor({
      listCommitDates,
      listCommitSummaries,
      sleep,
      now: () => 1000,
    });

    const result = await exec(step);

    expect(result.output).toEqual({ pushed: true, newCommitShas: ["abc123"] });
    expect(listCommitDates).toHaveBeenCalledTimes(1);
    expect(listCommitSummaries).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("detects push during polling on a later iteration", async () => {
    const listCommitDates = vi
      .fn<(pr: number) => Promise<string[]>>()
      .mockResolvedValueOnce(["2026-01-01T00:00:00.000Z"])
      .mockResolvedValueOnce([
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:01:30.000Z",
      ]);
    const listCommitSummaries = vi
      .fn<(pr: number) => Promise<{ sha: string; committedDate: string }[]>>()
      .mockResolvedValue([
        { sha: "old", committedDate: "2026-01-01T00:00:00.000Z" },
        { sha: "new", committedDate: "2026-01-01T00:01:30.000Z" },
      ]);
    let nowMs = 0;
    const sleep = vi.fn<(ms: number) => Promise<void>>((ms) => {
      nowMs += ms;
      return Promise.resolve();
    });
    const exec = createWaitAuthorPushExecutor({
      listCommitDates,
      listCommitSummaries,
      sleep,
      now: () => nowMs,
    });
    const step = makeStep({
      pr: 42,
      sinceReviewSubmittedAt: "2026-01-01T00:01:00.000Z",
      pollIntervalMs: 1000,
      timeoutMs: 10000,
    });

    const result = await exec(step);

    expect(result.output).toEqual({ pushed: true, newCommitShas: ["new"] });
    expect(listCommitDates).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("returns a completed timeout result when no new commit arrives in time", async () => {
    const listCommitDates = vi
      .fn<(pr: number) => Promise<string[]>>()
      .mockResolvedValue(["2026-01-01T00:00:00.000Z"]);
    const listCommitSummaries = vi
      .fn<(pr: number) => Promise<{ sha: string; committedDate: string }[]>>()
      .mockResolvedValue([]);
    let nowMs = 0;
    const sleep = vi.fn<(ms: number) => Promise<void>>((ms) => {
      nowMs += ms;
      return Promise.resolve();
    });
    const exec = createWaitAuthorPushExecutor({
      listCommitDates,
      listCommitSummaries,
      sleep,
      now: () => nowMs,
    });
    const step = makeStep({
      pr: 42,
      sinceReviewSubmittedAt: "2026-01-01T00:00:00.000Z",
      pollIntervalMs: 1000,
      timeoutMs: 2500,
    });

    const result = await exec(step);

    expect(result.output).toEqual({ pushed: false, reason: "timeout" });
    expect(listCommitDates).toHaveBeenCalledTimes(4);
    expect(listCommitSummaries).not.toHaveBeenCalled();
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1000, 1000, 1000]);
  });

  it("uses default timeout and poll interval values when not provided", async () => {
    const listCommitDates = vi
      .fn<(pr: number) => Promise<string[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["2026-01-01T00:00:02.000Z"]);
    const listCommitSummaries = vi
      .fn<(pr: number) => Promise<{ sha: string; committedDate: string }[]>>()
      .mockResolvedValue([
        { sha: "new-default", committedDate: "2026-01-01T00:00:02.000Z" },
      ]);
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const exec = createWaitAuthorPushExecutor({
      listCommitDates,
      listCommitSummaries,
      sleep,
      now: () => 0,
    });
    const step = makeStep({
      pr: 42,
      sinceReviewSubmittedAt: "2026-01-01T00:00:01.000Z",
    });

    const result = await exec(step);

    expect(result.output).toEqual({
      pushed: true,
      newCommitShas: ["new-default"],
    });
    expect(sleep).toHaveBeenCalledWith(
      DEFAULT_WAIT_AUTHOR_PUSH_POLL_INTERVAL_MS,
    );
  });

  it("rejects invalid input schema", async () => {
    const exec = createWaitAuthorPushExecutor({
      listCommitDates: () => Promise.resolve([]),
      listCommitSummaries: () => Promise.resolve([]),
      now: () => 0,
      sleep: async () => Promise.resolve(),
    });
    const step = makeStep({
      pr: "not-a-number",
      sinceReviewSubmittedAt: "not-an-iso-date",
      timeoutMs: -1,
      pollIntervalMs: -1,
    });

    await expect(exec(step)).rejects.toThrow();
  });

  it("exports defaults matching issue requirements", () => {
    expect(DEFAULT_WAIT_AUTHOR_PUSH_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_WAIT_AUTHOR_PUSH_POLL_INTERVAL_MS).toBe(60 * 1000);
    expect(DEFAULT_WAIT_AUTHOR_PUSH_TIMEOUT_MS).toBe(86_400_000);
  });
});
