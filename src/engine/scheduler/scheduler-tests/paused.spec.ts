import { describe, it, expect } from "vitest";
import { Collections } from "@/db/collections";
import { StepStatus } from "@/db/schemas";
import { runSchedulerTick } from "../loop";
import { makeConfig, makeDb, seedRun, seedPendingStep } from "./fixtures";

describe("runSchedulerTick skips steps belonging to a paused run (#121)", () => {
  it("leaves a paused run's pending step pending and does not admit it", async () => {
    const db = makeDb();
    const run = await seedRun(db, { paused: true });
    await seedPendingStep(db, {
      id: "step-1",
      runId: run.id,
      createdAt: 1000,
    });
    const report = await runSchedulerTick(db, makeConfig());
    expect(report.admitted).toHaveLength(0);
    const updated = await db.get(Collections.stepInstances, "step-1");
    expect(updated?.status).toBe(StepStatus.Pending);
  });

  it("admits the step again once the run is resumed (auto-resume, no manual unpark)", async () => {
    const db = makeDb();
    const run = await seedRun(db, { paused: true });
    await seedPendingStep(db, {
      id: "step-1",
      runId: run.id,
      createdAt: 1000,
    });
    await runSchedulerTick(db, makeConfig());

    await db.update(Collections.workflowRuns, run.id, { paused: false });
    const report = await runSchedulerTick(db, makeConfig());

    expect(report.admitted).toHaveLength(1);
    const updated = await db.get(Collections.stepInstances, "step-1");
    expect(updated?.status).toBe(StepStatus.Queued);
  });
});
