import { describe, expect, it } from "vitest";
import { EventType } from "@/db";
import {
  makeEventRecord,
  makeWorkflowRun,
} from "./observability-tests/fixtures";
import { computeMergeMetrics } from "./mergeMetrics";

describe("computeMergeMetrics", () => {
  it("derives efficiency metrics from the run and its events", () => {
    const run = makeWorkflowRun({
      createdAt: 0,
      completedAt: 60000,
      metrics: {
        totalClaudeMs: 12000,
        totalActiveMs: 3000,
        totalScheduleWaitMs: 1000,
        totalExternalWaitMs: 40000,
      },
    });
    const events = [
      makeEventRecord({
        id: "rev1",
        eventType: EventType.StepCompleted,
        decidingGate: "REVIEWED_BY_SKILL",
      }),
      makeEventRecord({ id: "ret1", eventType: EventType.StepRetried }),
      makeEventRecord({
        id: "merge",
        eventType: EventType.MergeCompleted,
        headSha: "cafe123",
      }),
    ];

    const metrics = computeMergeMetrics(run, events);

    expect(metrics.wallClockMs).toBe(60000);
    expect(metrics.claudeMs).toBe(12000);
    expect(metrics.externalWaitMs).toBe(40000);
    expect(metrics.reviewCycles).toBe(1);
    expect(metrics.retries).toBe(1);
    expect(metrics.headSha).toBe("cafe123");
    expect(metrics.mergedFirstTry).toBe(true);
  });

  it("marks mergedFirstTry false when a merge failure preceded the merge", () => {
    const run = makeWorkflowRun({ createdAt: 0, completedAt: 5000 });
    const events = [
      makeEventRecord({ id: "f1", eventType: EventType.MergeFailed }),
      makeEventRecord({ id: "m1", eventType: EventType.MergeCompleted }),
    ];

    expect(computeMergeMetrics(run, events).mergedFirstTry).toBe(false);
  });
});
