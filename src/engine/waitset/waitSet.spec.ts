import { describe, it, expect, vi, afterEach } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { StepStatus, StepType, type WorkflowRun } from "@/db/schemas";
import { drainWaitSet } from "./waitSet";
import {
  makePrSnapshot,
  makeRun,
  makeWaitStep,
} from "./waitset-tests/fixtures";

const passedSuite = {
  appName: "GitHub Actions",
  workflowName: "CI",
  status: "COMPLETED",
  conclusion: "SUCCESS",
};
const runningSuite = {
  appName: "GitHub Actions",
  workflowName: "CI",
  status: "IN_PROGRESS",
  conclusion: undefined,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a single bulk poll drains cleared CI waits and keeps the rest", () => {
  it("completes a CI wait whose snapshot has landed a verdict", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeRun());
    await db.create(Collections.stepInstances, makeWaitStep({ id: "s1" }));
    const fetchSnapshot = vi.fn(() =>
      Promise.resolve(makePrSnapshot({ checkSuites: [passedSuite] })),
    );

    const result = await drainWaitSet(db, { fetchSnapshot, now: () => 5000 });

    expect(result.cleared).toEqual(["s1"]);
    expect(result.pending).toEqual([]);
    const settled = await db.get(Collections.stepInstances, "s1");
    expect(settled?.status).toBe(StepStatus.Completed);
    expect(settled?.output).toEqual({ passed: true, kind: "ci" });
    expect(settled?.completedAt).toBe(5000);
  });

  it("keeps a CI wait whose Actions suite is still running", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeRun());
    await db.create(Collections.stepInstances, makeWaitStep({ id: "s1" }));
    const fetchSnapshot = vi.fn(() =>
      Promise.resolve(makePrSnapshot({ checkSuites: [runningSuite] })),
    );

    const result = await drainWaitSet(db, { fetchSnapshot });

    expect(result.cleared).toEqual([]);
    expect(result.pending).toEqual(["s1"]);
    const settled = await db.get(Collections.stepInstances, "s1");
    expect(settled?.status).toBe(StepStatus.Waiting);
  });
});

describe("the bulk poll snapshots each PR once regardless of step count", () => {
  it("fetches one snapshot per distinct PR, not one per waiting step", async () => {
    const db = createInMemoryDb();
    // Two PRs: run-1 has two waiting steps, run-2 has one.
    await db.create(Collections.workflowRuns, makeRun({ id: "run-1" }));
    await db.create(
      Collections.workflowRuns,
      makeRun({ id: "run-2", prNumber: 99 }),
    );
    await db.create(
      Collections.stepInstances,
      makeWaitStep({ id: "s1", runId: "run-1" }),
    );
    await db.create(
      Collections.stepInstances,
      makeWaitStep({ id: "s2", runId: "run-1" }),
    );
    await db.create(
      Collections.stepInstances,
      makeWaitStep({ id: "s3", runId: "run-2" }),
    );
    const fetchSnapshot = vi.fn((run: WorkflowRun) =>
      Promise.resolve(
        makePrSnapshot({ number: run.prNumber, checkSuites: [passedSuite] }),
      ),
    );

    const result = await drainWaitSet(db, { fetchSnapshot });

    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(result.polledPrs).toBe(2);
    expect(result.cleared.sort()).toEqual(["s1", "s2", "s3"]);
  });
});

describe("a failed snapshot read leaves the wait in place (fail open)", () => {
  it("keeps every step for a PR whose snapshot fetch throws", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeRun());
    await db.create(Collections.stepInstances, makeWaitStep({ id: "s1" }));
    const fetchSnapshot = vi.fn(() =>
      Promise.reject(new Error("rate limited")),
    );

    const result = await drainWaitSet(db, { fetchSnapshot });

    expect(result.cleared).toEqual([]);
    expect(result.pending).toEqual(["s1"]);
    const settled = await db.get(Collections.stepInstances, "s1");
    expect(settled?.status).toBe(StepStatus.Waiting);
  });
});

describe("the bulk poll ignores non-drainable wait kinds", () => {
  it("leaves a fix_pr wait untouched (drained through its own path)", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeRun());
    await db.create(
      Collections.stepInstances,
      makeWaitStep({ id: "s1", input: { kind: "fix_pr", pr: 42 } }),
    );
    const fetchSnapshot = vi.fn(() =>
      Promise.resolve(makePrSnapshot({ checkSuites: [passedSuite] })),
    );

    const result = await drainWaitSet(db, { fetchSnapshot });

    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(result.cleared).toEqual([]);
    expect(result.polledPrs).toBe(0);
  });

  it("ignores waiting steps that are not wait_external at all", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeRun());
    await db.create(
      Collections.stepInstances,
      makeWaitStep({
        id: "s1",
        stepType: StepType.WaitAuthorPush,
        input: { pr: 42 },
      }),
    );
    const fetchSnapshot = vi.fn(() => Promise.resolve(makePrSnapshot()));

    const result = await drainWaitSet(db, { fetchSnapshot });

    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(result.polledPrs).toBe(0);
  });
});
