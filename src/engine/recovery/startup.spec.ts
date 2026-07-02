import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import {
  RunStatus,
  StepStatus,
  StepType,
  type StepInstance,
} from "@/db/schemas";
import type { Db } from "@/db/types";
import {
  CRASH_RECOVERY_HEARTBEAT_WINDOW_MS,
  CRASH_RECOVERY_ORPHAN_RUN_ERROR,
  recoverFromCrash,
} from "./startup";

function makeBaseStep(): Omit<StepInstance, "id" | "runId" | "createdAt"> {
  return {
    stepDefinitionId: "step-a",
    stepType: StepType.ClaudeSkill,
    status: StepStatus.Pending,
    input: {},
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    metrics: {
      claudeMs: 0,
      activeMs: 0,
      scheduleWaitMs: 0,
      externalWaitMs: 0,
    },
  };
}

async function seedStep(
  db: Db,
  args: {
    id: string;
    runId: string;
    status: StepStatus;
    createdAt?: number;
    heartbeatAt?: number;
  },
): Promise<void> {
  await db.create(Collections.stepInstances, {
    ...makeBaseStep(),
    id: args.id,
    runId: args.runId,
    status: args.status,
    createdAt: args.createdAt ?? 1000,
    heartbeatAt: args.heartbeatAt,
  });
}

async function seedRun(
  db: Db,
  args: {
    id: string;
    status?: RunStatus;
    currentStepId?: string;
    updatedAt?: number;
  },
): Promise<void> {
  await db.create(Collections.workflowRuns, {
    id: args.id,
    workflowId: "wf-a",
    workflowVersion: 1,
    repo: "owner/repo",
    prNumber: 1,
    prTitle: "test",
    status: args.status ?? RunStatus.Running,
    childRunIds: [],
    context: {},
    currentStepId: args.currentStepId,
    createdAt: 1000,
    updatedAt: args.updatedAt ?? 1000,
    metrics: {
      totalClaudeMs: 0,
      totalActiveMs: 0,
      totalScheduleWaitMs: 0,
      totalExternalWaitMs: 0,
    },
  });
}

describe("recoverFromCrash", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("demotes queued steps back to pending", async () => {
    const db = createInMemoryDb();
    await seedRun(db, { id: "run-1" });
    await seedStep(db, {
      id: "step-queued",
      runId: "run-1",
      status: StepStatus.Queued,
    });

    const report = await recoverFromCrash(db);
    expect(report.demotedQueuedStepIds).toEqual(["step-queued"]);

    const step = await db.get(Collections.stepInstances, "step-queued");
    expect(step?.status).toBe(StepStatus.Pending);
  });

  it("leaves stale running steps unchanged for heartbeat monitor follow-up", async () => {
    const db = createInMemoryDb();
    await seedRun(db, { id: "run-1" });
    await seedStep(db, {
      id: "step-running-stale",
      runId: "run-1",
      status: StepStatus.Running,
      heartbeatAt: 1_000,
    });
    vi.spyOn(Date, "now").mockReturnValue(
      1_000 + CRASH_RECOVERY_HEARTBEAT_WINDOW_MS + 1,
    );

    const report = await recoverFromCrash(db);
    expect(report.staleRunningStepIds).toEqual(["step-running-stale"]);
    expect(report.warnedRunningSteps).toEqual([]);

    const step = await db.get(Collections.stepInstances, "step-running-stale");
    expect(step?.status).toBe(StepStatus.Running);
  });

  it("warns for running steps still inside the heartbeat window and includes age details", async () => {
    const db = createInMemoryDb();
    await seedRun(db, { id: "run-1" });
    await seedStep(db, {
      id: "step-running-fresh",
      runId: "run-1",
      status: StepStatus.Running,
      heartbeatAt: 10_000,
    });
    vi.spyOn(Date, "now").mockReturnValue(10_500);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());

    const report = await recoverFromCrash(db);
    expect(report.warnedRunningSteps).toEqual([
      {
        stepInstanceId: "step-running-fresh",
        heartbeatAt: 10_000,
        ageMs: 500,
      },
    ]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warning = warnSpy.mock.calls[0]?.[0];
    expect(warning).toContain("stepId=step-running-fresh");
    expect(warning).toContain("heartbeatAt=10000");
    expect(warning).toContain("ageMs=500");

    const step = await db.get(Collections.stepInstances, "step-running-fresh");
    expect(step?.status).toBe(StepStatus.Running);
  });

  it("does not orphan a running run whose currentStepId resolves to an existing step", async () => {
    // The regression guarding #285: enrollment sets currentStepId to the step
    // *instance* id, so recovery resolves it and leaves the healthy run alone.
    const db = createInMemoryDb();
    await seedRun(db, {
      id: "run-live",
      status: RunStatus.Running,
      currentStepId: "step-live",
    });
    await seedStep(db, {
      id: "step-live",
      runId: "run-live",
      status: StepStatus.Pending,
    });

    const report = await recoverFromCrash(db);

    expect(report.failedOrphanRunIds).toEqual([]);
    expect((await db.get(Collections.workflowRuns, "run-live"))?.status).toBe(
      RunStatus.Running,
    );
  });

  it("marks running orphan workflow runs as failed with a crash recovery error", async () => {
    const db = createInMemoryDb();
    await seedRun(db, {
      id: "run-orphan",
      status: RunStatus.Running,
      currentStepId: "missing-step",
    });

    const report = await recoverFromCrash(db);
    expect(report.failedOrphanRunIds).toEqual(["run-orphan"]);

    const run = await db.get(Collections.workflowRuns, "run-orphan");
    expect(run?.status).toBe(RunStatus.Failed);
    expect(run?.currentStepId).toBeUndefined();
    expect(run?.context["crashRecoveryError"]).toBe(
      CRASH_RECOVERY_ORPHAN_RUN_ERROR,
    );
  });

  it("is idempotent across repeated startup passes", async () => {
    const db = createInMemoryDb();
    await seedRun(db, {
      id: "run-orphan",
      status: RunStatus.Running,
      currentStepId: "missing-step",
    });
    await seedRun(db, { id: "run-2" });
    await seedStep(db, {
      id: "step-queued",
      runId: "run-2",
      status: StepStatus.Queued,
    });
    vi.spyOn(Date, "now").mockReturnValue(5_500);

    const first = await recoverFromCrash(db);
    expect(first.demotedQueuedStepIds).toEqual(["step-queued"]);
    expect(first.failedOrphanRunIds).toEqual(["run-orphan"]);
    expect(first.warnedRunningSteps).toEqual([]);

    const second = await recoverFromCrash(db);
    expect(second).toEqual({
      demotedQueuedStepIds: [],
      staleRunningStepIds: [],
      warnedRunningSteps: [],
      failedOrphanRunIds: [],
    });
  });
});
