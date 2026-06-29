import { describe, it, expect } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { RunStatus, StepStatus } from "@/db/schemas";
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

  it("excludes steps belonging to terminal (settled) runs", async () => {
    const db = createInMemoryDb();
    // A long-finished run: terminal status, its steps are settled history.
    await db.create(
      Collections.workflowRuns,
      makeRun({ id: "done", prNumber: 7, status: RunStatus.Completed }),
    );
    await db.create(
      Collections.stepInstances,
      makeWaitStep({ id: "old", runId: "done", status: StepStatus.Completed }),
    );
    // An active run still being drained at exit.
    await db.create(
      Collections.workflowRuns,
      makeRun({ id: "live", prNumber: 8, status: RunStatus.Running }),
    );
    await db.create(
      Collections.stepInstances,
      makeWaitStep({ id: "new", runId: "live", status: StepStatus.Running }),
    );

    const aggregate = await aggregateDrainResults(db);

    // Only the active run's PR appears; the terminal run is not scanned.
    expect(aggregate.perPr).toEqual([
      {
        repo: "rmartz/pr-shepherd",
        prNumber: 8,
        completed: 0,
        failed: 0,
        inFlight: 1,
      },
    ]);
    expect(aggregate.totalInFlight).toBe(1);
  });
});
