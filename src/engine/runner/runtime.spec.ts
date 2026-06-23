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
import { createRunner } from "./index";
import type { StepExecutor } from "./index";

// ---------------------------------------------------------------------------
// Tests for the `StepExecutorRuntime` handle the runner passes as the
// executor's second argument. The runtime lets a long-running executor
// persist intermediate lifecycle state — a `running → waiting` transition
// and periodic heartbeat / externalWaitMs accumulation — that the original
// #56 contract dropped because executors could only return a terminal
// `ExecutorResult`. See #78.
// ---------------------------------------------------------------------------

function makeBaseStepInstance(): Omit<
  StepInstance,
  "id" | "runId" | "createdAt"
> {
  return {
    stepDefinitionId: "step-x",
    stepType: StepType.WaitExternal,
    status: StepStatus.Queued,
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

async function seedRunAndStep(db: Db): Promise<StepInstance> {
  await db.create(Collections.workflowRuns, makeWorkflowRun());
  const step: StepInstance = {
    ...makeBaseStepInstance(),
    id: "step-1",
    runId: "run-1",
    createdAt: 1000,
    queuedAt: 1500,
  };
  await db.create(Collections.stepInstances, step);
  const fetched = await db.get(Collections.stepInstances, "step-1");
  return fetched!;
}

describe("StepExecutorRuntime.enterWaiting persists a running → waiting transition", () => {
  it("sets status to waiting and records waitingAt while the executor runs", async () => {
    const db = createInMemoryDb();
    const step = await seedRunAndStep(db);
    const observed: { status?: StepStatus; waitingAt?: number } = {};
    const executor: StepExecutor = async (_step, runtime) => {
      await runtime.enterWaiting();
      const inFlight = await db.get(Collections.stepInstances, "step-1");
      observed.status = inFlight?.status;
      observed.waitingAt = inFlight?.waitingAt;
      return { output: { ok: true } };
    };
    const runner = createRunner(db, { [StepType.WaitExternal]: executor });
    await runner.dispatch(step);
    expect(observed.status).toBe(StepStatus.Waiting);
    expect(observed.waitingAt).toBeGreaterThan(0);
  });

  it("is idempotent — a second call does not overwrite the original waitingAt", async () => {
    const db = createInMemoryDb();
    const step = await seedRunAndStep(db);
    const observed: { firstWaitingAt?: number; secondWaitingAt?: number } = {};
    const nowSpy = vi.spyOn(Date, "now");
    // dispatch start, first enterWaiting, second enterWaiting, completion.
    nowSpy
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(2100)
      .mockReturnValueOnce(2200)
      .mockReturnValue(2300);
    const executor: StepExecutor = async (_step, runtime) => {
      await runtime.enterWaiting();
      observed.firstWaitingAt = (
        await db.get(Collections.stepInstances, "step-1")
      )?.waitingAt;
      await runtime.enterWaiting();
      observed.secondWaitingAt = (
        await db.get(Collections.stepInstances, "step-1")
      )?.waitingAt;
      return { output: {} };
    };
    const runner = createRunner(db, { [StepType.WaitExternal]: executor });
    try {
      await runner.dispatch(step);
    } finally {
      nowSpy.mockRestore();
    }
    expect(observed.firstWaitingAt).toBe(2100);
    expect(observed.secondWaitingAt).toBe(2100);
  });
});

describe("StepExecutorRuntime.heartbeat refreshes heartbeatAt and accumulates externalWaitMs", () => {
  it("advances heartbeatAt to the current time on each call", async () => {
    const db = createInMemoryDb();
    const step = await seedRunAndStep(db);
    const observed: { startHeartbeat?: number; afterHeartbeat?: number } = {};
    const nowSpy = vi.spyOn(Date, "now");
    // dispatch start (heartbeatAt = 5000), heartbeat() (5500), completion.
    nowSpy
      .mockReturnValueOnce(5000)
      .mockReturnValueOnce(5500)
      .mockReturnValue(6000);
    const executor: StepExecutor = async (_step, runtime) => {
      observed.startHeartbeat = (
        await db.get(Collections.stepInstances, "step-1")
      )?.heartbeatAt;
      await runtime.heartbeat();
      observed.afterHeartbeat = (
        await db.get(Collections.stepInstances, "step-1")
      )?.heartbeatAt;
      return { output: {} };
    };
    const runner = createRunner(db, { [StepType.WaitExternal]: executor });
    try {
      await runner.dispatch(step);
    } finally {
      nowSpy.mockRestore();
    }
    expect(observed.startHeartbeat).toBe(5000);
    expect(observed.afterHeartbeat).toBe(5500);
  });

  it("accumulates externalWaitMs across multiple heartbeat(deltaMs) calls", async () => {
    const db = createInMemoryDb();
    const step = await seedRunAndStep(db);
    const observed: { externalWaitMs?: number } = {};
    const executor: StepExecutor = async (_step, runtime) => {
      await runtime.heartbeat(100);
      await runtime.heartbeat(250);
      observed.externalWaitMs = (
        await db.get(Collections.stepInstances, "step-1")
      )?.metrics.externalWaitMs;
      return { output: {} };
    };
    const runner = createRunner(db, { [StepType.WaitExternal]: executor });
    await runner.dispatch(step);
    expect(observed.externalWaitMs).toBe(350);
  });

  it("leaves externalWaitMs unchanged when called without a delta", async () => {
    const db = createInMemoryDb();
    const step = await seedRunAndStep(db);
    const observed: { externalWaitMs?: number } = {};
    const executor: StepExecutor = async (_step, runtime) => {
      await runtime.heartbeat();
      observed.externalWaitMs = (
        await db.get(Collections.stepInstances, "step-1")
      )?.metrics.externalWaitMs;
      return { output: {} };
    };
    const runner = createRunner(db, { [StepType.WaitExternal]: executor });
    await runner.dispatch(step);
    expect(observed.externalWaitMs).toBe(0);
  });
});
