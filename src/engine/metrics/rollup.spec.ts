import { describe, expect, it } from "vitest";
import { StepType } from "@/db/schemas";
import { applyStepDelta, computeStepMetrics } from "./rollup";

describe("computeStepMetrics", () => {
  it("computes buckets for claude_skill timestamps", () => {
    const metrics = computeStepMetrics({
      stepType: StepType.ClaudeSkill,
      createdAt: 100,
      queuedAt: 140,
      startedAt: 200,
      waitingAt: undefined,
      completedAt: 500,
    });
    expect(metrics).toEqual({
      claudeMs: 300,
      activeMs: 0,
      scheduleWaitMs: 40,
      externalWaitMs: 0,
    });
  });

  it("computes buckets for wait_external timestamps", () => {
    const metrics = computeStepMetrics({
      stepType: StepType.WaitExternal,
      createdAt: 100,
      queuedAt: 130,
      startedAt: 150,
      waitingAt: 220,
      completedAt: 460,
    });
    expect(metrics).toEqual({
      claudeMs: 0,
      activeMs: 70,
      scheduleWaitMs: 30,
      externalWaitMs: 240,
    });
  });

  it("computes buckets for decision timestamps", () => {
    const metrics = computeStepMetrics({
      stepType: StepType.Decision,
      createdAt: 100,
      queuedAt: 100,
      startedAt: 110,
      waitingAt: undefined,
      completedAt: 125,
    });
    expect(metrics).toEqual({
      claudeMs: 0,
      activeMs: 15,
      scheduleWaitMs: 0,
      externalWaitMs: 0,
    });
  });

  it("computes buckets for github_api timestamps", () => {
    const metrics = computeStepMetrics({
      stepType: StepType.GithubApi,
      createdAt: 100,
      queuedAt: 120,
      startedAt: 150,
      waitingAt: undefined,
      completedAt: 210,
    });
    expect(metrics).toEqual({
      claudeMs: 0,
      activeMs: 60,
      scheduleWaitMs: 20,
      externalWaitMs: 0,
    });
  });
});

describe("applyStepDelta", () => {
  it("returns deterministic additive totals without mutating input metrics", () => {
    const runMetrics = {
      totalClaudeMs: 1000,
      totalActiveMs: 2000,
      totalScheduleWaitMs: 3000,
      totalExternalWaitMs: 4000,
    };
    const stepDelta = {
      claudeMs: 11,
      activeMs: 22,
      scheduleWaitMs: 33,
      externalWaitMs: 44,
    };

    const updated = applyStepDelta(runMetrics, stepDelta);

    expect(updated).toEqual({
      totalClaudeMs: 1011,
      totalActiveMs: 2022,
      totalScheduleWaitMs: 3033,
      totalExternalWaitMs: 4044,
    });
    expect(runMetrics).toEqual({
      totalClaudeMs: 1000,
      totalActiveMs: 2000,
      totalScheduleWaitMs: 3000,
      totalExternalWaitMs: 4000,
    });
  });
});
