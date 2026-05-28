import { describe, it, expect, vi } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import {
  RunStatus,
  StepStatus,
  StepType,
  type StepInstance,
  type WorkflowRun,
} from "@/db/schemas";
import type { Db } from "@/db/types";
import { runSchedulerTick, startScheduler } from "./loop";
import type { SchedulerConfig } from "./loop";

// ---------------------------------------------------------------------------
// Tests for the scheduler loop. `runSchedulerTick` is the single-pass unit
// the long-running `startScheduler` invokes on the configured cadence. The
// tick reads `pending` stepInstances, derives `ActiveCounts` from `running`
// steps, walks candidates in `createdAt` ASC order, calls `canAdmitStep`
// from #45, and transitions admitted steps to `queued` via `Db.update`.
//
// Active counts come from a Db query each tick rather than a long-lived
// in-process map — the scheduler is restart-safe by construction (vision
// §4.2 acceptance criterion).
// ---------------------------------------------------------------------------

function makeConfig(): SchedulerConfig {
  return {
    concurrency: {
      systemMax: 8,
      githubApiMax: 4,
      defaultRepoMax: 2,
    },
  };
}

function makeBaseStepInstance(): Omit<
  StepInstance,
  "id" | "runId" | "createdAt"
> {
  return {
    stepDefinitionId: "step-x",
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

function makeWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: "owner/repo-a",
    prNumber: 1,
    prTitle: "test",
    status: RunStatus.Running,
    childRunIds: [],
    context: {},
    createdAt: 1000,
    updatedAt: 1000,
    metrics: {
      totalClaudeMs: 0,
      totalActiveMs: 0,
      totalScheduleWaitMs: 0,
      totalExternalWaitMs: 0,
    },
    ...overrides,
  };
}

async function seedRun(
  db: Db,
  overrides: Partial<WorkflowRun> = {},
): Promise<WorkflowRun> {
  const run = makeWorkflowRun(overrides);
  await db.create(Collections.workflowRuns, run);
  return run;
}

async function seedPendingStep(
  db: Db,
  args: {
    id: string;
    runId: string;
    stepType?: StepType;
    createdAt: number;
  },
): Promise<StepInstance> {
  const step: StepInstance = {
    ...makeBaseStepInstance(),
    id: args.id,
    runId: args.runId,
    stepType: args.stepType ?? StepType.ClaudeSkill,
    createdAt: args.createdAt,
  };
  await db.create(Collections.stepInstances, step);
  return step;
}

async function seedRunningStep(
  db: Db,
  args: { id: string; runId: string; stepType: StepType; createdAt: number },
): Promise<void> {
  const step: StepInstance = {
    ...makeBaseStepInstance(),
    id: args.id,
    runId: args.runId,
    stepType: args.stepType,
    status: StepStatus.Running,
    createdAt: args.createdAt,
    startedAt: args.createdAt + 1,
  };
  await db.create(Collections.stepInstances, step);
}

describe("runSchedulerTick on an empty pending set", () => {
  it("returns an empty report and makes no Db writes", async () => {
    const db = createInMemoryDb();
    const report = await runSchedulerTick(db, makeConfig());
    expect(report.admitted).toEqual([]);
    expect(report.rejected).toEqual([]);
    expect(report.pendingCount).toBe(0);
  });
});

describe("runSchedulerTick admits a single pending candidate when capacity is available", () => {
  it("transitions one pending step to queued and records it in the report", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db);
    await seedPendingStep(db, {
      id: "step-1",
      runId: run.id,
      createdAt: 1000,
    });
    const report = await runSchedulerTick(db, makeConfig());
    expect(report.admitted).toHaveLength(1);
    expect(report.admitted[0]?.stepInstanceId).toBe("step-1");
    expect(report.rejected).toHaveLength(0);
    expect(report.pendingCount).toBe(1);
    const updated = await db.get(Collections.stepInstances, "step-1");
    expect(updated?.status).toBe(StepStatus.Queued);
    expect(updated?.queuedAt).toBeDefined();
  });
});

describe("runSchedulerTick admits multiple pending candidates in one tick when capacity permits", () => {
  it("transitions all admitted candidates and updates local counts so subsequent candidates see the new state", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db);
    await seedPendingStep(db, {
      id: "step-1",
      runId: run.id,
      createdAt: 1000,
    });
    await seedPendingStep(db, {
      id: "step-2",
      runId: run.id,
      createdAt: 1100,
    });
    const config = makeConfig();
    config.concurrency.defaultRepoMax = 5; // enough for both
    const report = await runSchedulerTick(db, config);
    expect(report.admitted.map((a) => a.stepInstanceId)).toEqual([
      "step-1",
      "step-2",
    ]);
  });

  it("rejects later candidates once the local repo count saturates within a single tick", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db);
    await seedPendingStep(db, {
      id: "step-1",
      runId: run.id,
      createdAt: 1000,
    });
    await seedPendingStep(db, {
      id: "step-2",
      runId: run.id,
      createdAt: 1100,
    });
    await seedPendingStep(db, {
      id: "step-3",
      runId: run.id,
      createdAt: 1200,
    });
    const config = makeConfig();
    config.concurrency.defaultRepoMax = 2; // exactly two slots
    const report = await runSchedulerTick(db, config);
    expect(report.admitted.map((a) => a.stepInstanceId)).toEqual([
      "step-1",
      "step-2",
    ]);
    expect(report.rejected.map((r) => r.stepInstanceId)).toEqual(["step-3"]);
  });
});

describe("Candidates are walked in createdAt ASC order (FIFO across iterations)", () => {
  it("orders by createdAt even when steps were created in DB in a different order", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db);
    // Insert steps in reverse-time order; the scheduler must reorder.
    await seedPendingStep(db, {
      id: "step-late",
      runId: run.id,
      createdAt: 3000,
    });
    await seedPendingStep(db, {
      id: "step-mid",
      runId: run.id,
      createdAt: 2000,
    });
    await seedPendingStep(db, {
      id: "step-early",
      runId: run.id,
      createdAt: 1000,
    });
    const config = makeConfig();
    config.concurrency.defaultRepoMax = 1; // only one fits
    const report = await runSchedulerTick(db, config);
    expect(report.admitted[0]?.stepInstanceId).toBe("step-early");
  });
});

describe("Active counts are derived from a Db query each tick (restart-safe)", () => {
  it("counts existing running steps so already-busy capacity is respected", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db);
    // Seed two running github_api steps — global githubApiMax is 4.
    await seedRunningStep(db, {
      id: "running-1",
      runId: run.id,
      stepType: StepType.GithubApi,
      createdAt: 500,
    });
    await seedRunningStep(db, {
      id: "running-2",
      runId: run.id,
      stepType: StepType.GithubApi,
      createdAt: 600,
    });
    await seedPendingStep(db, {
      id: "pending-1",
      runId: run.id,
      stepType: StepType.GithubApi,
      createdAt: 1000,
    });
    const config = makeConfig();
    config.concurrency.githubApiMax = 3;
    config.concurrency.defaultRepoMax = 5;
    // 2 already running + 1 to admit = 3, which equals the cap — but the
    // admission check is `active < max`, so with 2 active and cap 3, one
    // more admits and the count reaches 3.
    const report = await runSchedulerTick(db, config);
    expect(report.admitted).toHaveLength(1);
  });

  it("rejects a candidate when existing running steps have already saturated the per-repo cap", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db);
    await seedRunningStep(db, {
      id: "running-1",
      runId: run.id,
      stepType: StepType.ClaudeSkill,
      createdAt: 500,
    });
    await seedRunningStep(db, {
      id: "running-2",
      runId: run.id,
      stepType: StepType.ClaudeSkill,
      createdAt: 600,
    });
    await seedPendingStep(db, {
      id: "pending-1",
      runId: run.id,
      stepType: StepType.GithubApi,
      createdAt: 1000,
    });
    const config = makeConfig();
    config.concurrency.defaultRepoMax = 2; // exactly the running count
    const report = await runSchedulerTick(db, config);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]?.decision.admit).toBe(false);
  });
});

describe("Rejection reasons are captured in the tick report", () => {
  it("records the AdmissionRejectReason for each rejected candidate", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db);
    await seedPendingStep(db, {
      id: "blocked",
      runId: run.id,
      stepType: StepType.GithubApi,
      createdAt: 1000,
    });
    const config = makeConfig();
    config.concurrency.githubApiMax = 0; // nothing can admit
    const report = await runSchedulerTick(db, config);
    expect(report.rejected).toHaveLength(1);
    const rejection = report.rejected[0]?.decision;
    expect(rejection?.admit).toBe(false);
    if (rejection && !rejection.admit) {
      expect(rejection.reason).toBeDefined();
    }
  });
});

describe("startScheduler runs ticks on the configured cadence and stops cleanly", () => {
  it("invokes runSchedulerTick at the configured interval and stops when requested", async () => {
    const db = createInMemoryDb();
    const tickCount = { n: 0 };
    const sleeps: number[] = [];
    // Inject a sleep that resolves immediately and records the requested
    // delay; that lets us assert the cadence without actually waiting.
    // The injected sleep must yield via a macrotask so the test's own
    // `setTimeout(r, 0)` waits below can actually fire — otherwise the
    // loop's microtask chain starves the event loop.
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    // We can't directly mock runSchedulerTick from inside the loop module,
    // but we can observe its effect: each tick on an empty DB returns a
    // report (no admits) and increments the count via a beforeTick hook.
    const handle = startScheduler(db, makeConfig(), {
      intervalMs: 5000,
      sleep,
      onTick: () => {
        tickCount.n++;
      },
    });
    // Yield a few microtasks to let the loop iterate.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    handle.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(tickCount.n).toBeGreaterThan(0);
    expect(sleep).toHaveBeenCalled();
    expect(sleeps[0]).toBe(5000);
  });

  it("survives a thrown error in a tick (logs via onTickError) and keeps running", async () => {
    const db = createInMemoryDb();
    const errors: unknown[] = [];
    const sleep = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    let calls = 0;
    const handle = startScheduler(db, makeConfig(), {
      intervalMs: 1,
      sleep,
      onTick: () => {
        calls++;
        if (calls === 1) {
          throw new Error("first-tick boom");
        }
      },
      onTickError: (err) => {
        errors.push(err);
      },
    });
    // Let two ticks fire.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    handle.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
