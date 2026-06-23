import { describe, expect, it } from "vitest";
import { makeWorkflowRun } from "../observability-tests/fixtures";
import { detectMassBlocking, medianWallClockMs } from "./crossRun";
import { AnomalyKind } from "./types";

describe("detectMassBlocking", () => {
  it("flags when paused runs meet the threshold", () => {
    const runs = [
      makeWorkflowRun({ id: "r1", paused: true }),
      makeWorkflowRun({ id: "r2", paused: true, repo: "owner/other" }),
      makeWorkflowRun({ id: "r3", paused: true }),
    ];

    const anomalies = detectMassBlocking(runs);
    expect(anomalies[0]?.kind).toBe(AnomalyKind.MassBlocking);
    expect(anomalies[0]?.body).toContain("owner/other");
  });

  it("does not flag below the threshold", () => {
    const runs = [
      makeWorkflowRun({ id: "r1", paused: true }),
      makeWorkflowRun({ id: "r2", paused: false }),
    ];

    expect(detectMassBlocking(runs)).toHaveLength(0);
  });
});

describe("medianWallClockMs", () => {
  it("computes the median of completed-run durations", () => {
    const runs = [
      makeWorkflowRun({ id: "r1", createdAt: 0, completedAt: 1000 }),
      makeWorkflowRun({ id: "r2", createdAt: 0, completedAt: 3000 }),
      makeWorkflowRun({ id: "r3", createdAt: 0, completedAt: 9000 }),
    ];

    expect(medianWallClockMs(runs)).toBe(3000);
  });

  it("returns 0 when no run has completed", () => {
    const runs = [makeWorkflowRun({ id: "r1", completedAt: undefined })];

    expect(medianWallClockMs(runs)).toBe(0);
  });
});
