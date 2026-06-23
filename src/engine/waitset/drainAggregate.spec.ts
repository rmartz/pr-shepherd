import { describe, it, expect } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { StepStatus } from "@/db/schemas";
import { aggregateDrainResults } from "./drainAggregate";
import { makeRun, makeWaitStep } from "./waitset-tests/fixtures";

describe("graceful-drain aggregation rolls steps up per PR", () => {
  it("counts completed, failed, and in-flight steps for one PR", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeRun({ id: "run-1" }));
    await db.create(
      Collections.stepInstances,
      makeWaitStep({ id: "a", runId: "run-1", status: StepStatus.Completed }),
    );
    await db.create(
      Collections.stepInstances,
      makeWaitStep({ id: "b", runId: "run-1", status: StepStatus.Failed }),
    );
    await db.create(
      Collections.stepInstances,
      makeWaitStep({ id: "c", runId: "run-1", status: StepStatus.Running }),
    );
    await db.create(
      Collections.stepInstances,
      makeWaitStep({ id: "d", runId: "run-1", status: StepStatus.Waiting }),
    );

    const aggregate = await aggregateDrainResults(db);

    expect(aggregate.perPr).toEqual([
      {
        repo: "rmartz/pr-shepherd",
        prNumber: 42,
        completed: 1,
        failed: 1,
        inFlight: 2,
      },
    ]);
    expect(aggregate.totalInFlight).toBe(2);
  });

  it("aggregates multiple PRs in a stable repo/prNumber order", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.workflowRuns,
      makeRun({ id: "run-1", prNumber: 99 }),
    );
    await db.create(
      Collections.workflowRuns,
      makeRun({ id: "run-2", prNumber: 7 }),
    );
    await db.create(
      Collections.stepInstances,
      makeWaitStep({ id: "a", runId: "run-1", status: StepStatus.Completed }),
    );
    await db.create(
      Collections.stepInstances,
      makeWaitStep({ id: "b", runId: "run-2", status: StepStatus.Running }),
    );

    const aggregate = await aggregateDrainResults(db);

    // PR 7 sorts before PR 99 within the same repo.
    expect(aggregate.perPr.map((p) => p.prNumber)).toEqual([7, 99]);
    expect(aggregate.totalInFlight).toBe(1);
  });

  it("skips steps whose run is missing rather than throwing", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.stepInstances,
      makeWaitStep({ id: "orphan", runId: "gone", status: StepStatus.Running }),
    );

    const aggregate = await aggregateDrainResults(db);

    expect(aggregate.perPr).toEqual([]);
    expect(aggregate.totalInFlight).toBe(0);
  });
});
