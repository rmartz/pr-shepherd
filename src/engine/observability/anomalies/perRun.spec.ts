import { describe, expect, it } from "vitest";
import { EventType } from "@/db";
import {
  makeEventRecord,
  makeWorkflowRun,
} from "../observability-tests/fixtures";
import {
  detectDurationOutlier,
  detectFixReviewLoop,
  detectHighRetryRate,
  detectMergeFailure,
  detectTimeoutThenFastRetry,
} from "./perRun";
import { AnomalyKind } from "./types";

describe("detectTimeoutThenFastRetry", () => {
  it("flags a timeout failure whose retry completed within the window", () => {
    const events = [
      makeEventRecord({
        id: "e1",
        eventType: EventType.StepFailed,
        outcome: "timeout",
        stepInstanceId: "step-9",
        createdAt: 1000,
      }),
      makeEventRecord({
        id: "e2",
        eventType: EventType.StepCompleted,
        stepInstanceId: "step-9",
        createdAt: 3000,
      }),
    ];

    const anomalies = detectTimeoutThenFastRetry(events, {
      durationOutlierMultiple: 3,
      fastRetryMs: 5000,
      fixReviewLoopCycles: 4,
      highRetryRatio: 0.5,
      massBlockingRuns: 3,
    });

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.kind).toBe(AnomalyKind.TimeoutThenFastRetry);
  });

  it("does not flag when the retry took longer than the window", () => {
    const events = [
      makeEventRecord({
        id: "e1",
        eventType: EventType.StepFailed,
        outcome: "timeout",
        stepInstanceId: "step-9",
        createdAt: 1000,
      }),
      makeEventRecord({
        id: "e2",
        eventType: EventType.StepCompleted,
        stepInstanceId: "step-9",
        createdAt: 20000,
      }),
    ];

    expect(
      detectTimeoutThenFastRetry(events, {
        durationOutlierMultiple: 3,
        fastRetryMs: 5000,
        fixReviewLoopCycles: 4,
        highRetryRatio: 0.5,
        massBlockingRuns: 3,
      }),
    ).toHaveLength(0);
  });

  it("ignores non-timeout failures even with a fast retry", () => {
    const events = [
      makeEventRecord({
        id: "e1",
        eventType: EventType.StepFailed,
        outcome: "process_restart",
        stepInstanceId: "step-9",
        createdAt: 1000,
      }),
      makeEventRecord({
        id: "e2",
        eventType: EventType.StepCompleted,
        stepInstanceId: "step-9",
        createdAt: 1500,
      }),
    ];

    expect(detectTimeoutThenFastRetry(events)).toHaveLength(0);
  });
});

describe("detectFixReviewLoop", () => {
  it("flags a run with review cycles at the threshold", () => {
    const events = Array.from({ length: 4 }, (_, i) =>
      makeEventRecord({
        id: `r${i}`,
        eventType: EventType.StepCompleted,
        decidingGate: "REVIEWED_BY_SKILL",
        createdAt: 1000 + i,
      }),
    );

    expect(detectFixReviewLoop(events)[0]?.kind).toBe(
      AnomalyKind.FixReviewLoop,
    );
  });

  it("does not flag below the threshold", () => {
    const events = Array.from({ length: 3 }, (_, i) =>
      makeEventRecord({
        id: `r${i}`,
        eventType: EventType.StepCompleted,
        decidingGate: "REVIEWED_BY_SKILL",
        createdAt: 1000 + i,
      }),
    );

    expect(detectFixReviewLoop(events)).toHaveLength(0);
  });
});

describe("detectHighRetryRate", () => {
  it("flags when retries meet the ratio of started steps", () => {
    const events = [
      makeEventRecord({ id: "s1", eventType: EventType.StepStarted }),
      makeEventRecord({ id: "s2", eventType: EventType.StepStarted }),
      makeEventRecord({ id: "r1", eventType: EventType.StepRetried }),
      makeEventRecord({ id: "r2", eventType: EventType.StepRetried }),
    ];

    expect(detectHighRetryRate(events)[0]?.kind).toBe(
      AnomalyKind.HighRetryRate,
    );
  });

  it("does not flag a clean run", () => {
    const events = [
      makeEventRecord({ id: "s1", eventType: EventType.StepStarted }),
      makeEventRecord({ id: "s2", eventType: EventType.StepStarted }),
    ];

    expect(detectHighRetryRate(events)).toHaveLength(0);
  });
});

describe("detectMergeFailure", () => {
  it("flags each merge_failed event", () => {
    const events = [
      makeEventRecord({
        id: "m1",
        eventType: EventType.MergeFailed,
        headSha: "deadbeef",
        outcome: "conflict",
      }),
    ];

    const anomalies = detectMergeFailure(events);
    expect(anomalies[0]?.kind).toBe(AnomalyKind.MergeFailure);
    expect(anomalies[0]?.body).toContain("deadbeef");
  });
});

describe("detectDurationOutlier", () => {
  it("flags a run at or above the median multiple", () => {
    const run = makeWorkflowRun({ createdAt: 0, completedAt: 30000 });

    expect(detectDurationOutlier(run, 5000)[0]?.kind).toBe(
      AnomalyKind.DurationOutlier,
    );
  });

  it("does not flag a run near the median", () => {
    const run = makeWorkflowRun({ createdAt: 0, completedAt: 6000 });

    expect(detectDurationOutlier(run, 5000)).toHaveLength(0);
  });
});
