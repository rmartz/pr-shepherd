import { describe, it, expect } from "vitest";
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
import { createRunner, noopExecutor } from "./index";
import type { StepExecutor, ExecutorResult } from "./index";

// ---------------------------------------------------------------------------
// Tests for the runner — the component that picks up `queued` step
// instances and executes them. The runner looks up the executor for the
// step's `stepType`, transitions queued → running → (completed | failed),
// captures the executor's output (merging into parent `workflowRun.context`
// on success) or its error (incrementing `retryCount` on failure), and
// sets `heartbeatAt` when the step starts running so the heartbeat monitor
// can detect dead runs.
//
// Epic 3 ships only the noop executor; real executors (`claude_skill`,
// `github_api`, etc.) land in Epic 4 (#7) and register themselves via
// `runner.register(stepType, executor)`.
// ---------------------------------------------------------------------------

function makeBaseStepInstance(): Omit<
  StepInstance,
  "id" | "runId" | "createdAt"
> {
  return {
    stepDefinitionId: "step-x",
    stepType: StepType.ClaudeSkill,
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

async function seedRun(
  db: Db,
  overrides: Partial<WorkflowRun> = {},
): Promise<WorkflowRun> {
  const run = makeWorkflowRun(overrides);
  await db.create(Collections.workflowRuns, run);
  return run;
}

async function seedQueuedStep(
  db: Db,
  args: {
    id: string;
    runId: string;
    stepType?: StepType;
    input?: Record<string, unknown>;
  },
): Promise<StepInstance> {
  const step: StepInstance = {
    ...makeBaseStepInstance(),
    id: args.id,
    runId: args.runId,
    stepType: args.stepType ?? StepType.ClaudeSkill,
    input: args.input ?? {},
    createdAt: 1000,
    queuedAt: 1500,
  };
  await db.create(Collections.stepInstances, step);
  return step;
}

describe("createRunner returns a Runner with register and dispatch", () => {
  it("registers an executor for a stepType and dispatches a queued step through it", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db);
    await seedQueuedStep(db, {
      id: "step-1",
      runId: run.id,
      stepType: StepType.ClaudeSkill,
    });
    let executorCalled = false;
    const executor: StepExecutor = () => {
      executorCalled = true;
      return Promise.resolve({ output: { hello: "world" } });
    };
    const runner = createRunner(db, { [StepType.ClaudeSkill]: executor });
    const step = await db.get(Collections.stepInstances, "step-1");
    await runner.dispatch(step!);
    expect(executorCalled).toBe(true);
  });
});

describe("Runner transitions queued → running → completed on executor success", () => {
  it("updates status to completed and records heartbeatAt at start", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db);
    await seedQueuedStep(db, { id: "step-1", runId: run.id });
    const observed: { runningHeartbeat?: number } = {};
    const executor: StepExecutor = async () => {
      // Peek at the row mid-execution to confirm the runner already
      // marked us running and set heartbeatAt before invoking us.
      const inFlight = await db.get(Collections.stepInstances, "step-1");
      observed.runningHeartbeat = inFlight?.heartbeatAt;
      return { output: {} };
    };
    const runner = createRunner(db, { [StepType.ClaudeSkill]: executor });
    const step = await db.get(Collections.stepInstances, "step-1");
    await runner.dispatch(step!);
    const final = await db.get(Collections.stepInstances, "step-1");
    expect(final?.status).toBe(StepStatus.Completed);
    expect(observed.runningHeartbeat).toBeGreaterThan(0);
    expect(final?.completedAt).toBeGreaterThan(0);
  });
});

describe("Runner merges executor output into the parent workflowRun.context on success", () => {
  it("merges the new keys into the existing run context", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db, { context: { existing: "keep-me" } });
    await seedQueuedStep(db, { id: "step-1", runId: run.id });
    const executor: StepExecutor = () =>
      Promise.resolve({ output: { newKey: "added" } });
    const runner = createRunner(db, { [StepType.ClaudeSkill]: executor });
    const step = await db.get(Collections.stepInstances, "step-1");
    await runner.dispatch(step!);
    const updatedRun = await db.get(Collections.workflowRuns, run.id);
    expect(updatedRun?.context).toEqual({
      existing: "keep-me",
      newKey: "added",
    });
  });
});

describe("Runner transitions to failed when the executor throws", () => {
  it("captures the error message and increments retryCount", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db);
    await seedQueuedStep(db, { id: "step-1", runId: run.id });
    const executor: StepExecutor = () =>
      Promise.reject(new Error("boom from executor"));
    const runner = createRunner(db, { [StepType.ClaudeSkill]: executor });
    const step = await db.get(Collections.stepInstances, "step-1");
    await runner.dispatch(step!);
    const final = await db.get(Collections.stepInstances, "step-1");
    expect(final?.status).toBe(StepStatus.Failed);
    expect(final?.error).toContain("boom from executor");
    expect(final?.retryCount).toBe(1);
  });
});

describe("Runner fails the step when no executor is registered for the stepType", () => {
  it("captures a clear 'no executor registered' error and does not crash", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db);
    await seedQueuedStep(db, {
      id: "step-1",
      runId: run.id,
      stepType: StepType.GithubApi,
    });
    // Register only a ClaudeSkill executor — GithubApi will be unknown.
    const runner = createRunner(db, {
      [StepType.ClaudeSkill]: noopExecutor,
    });
    const step = await db.get(Collections.stepInstances, "step-1");
    await runner.dispatch(step!);
    const final = await db.get(Collections.stepInstances, "step-1");
    expect(final?.status).toBe(StepStatus.Failed);
    expect(final?.error).toContain("no executor registered");
    expect(final?.error).toContain(StepType.GithubApi);
  });
});

describe("runner.register adds an executor after construction", () => {
  it("late-registered executor is used by subsequent dispatch calls", async () => {
    const db = createInMemoryDb();
    const run = await seedRun(db);
    await seedQueuedStep(db, {
      id: "step-1",
      runId: run.id,
      stepType: StepType.GithubApi,
    });
    const runner = createRunner(db, {});
    const result: ExecutorResult = { output: { ok: true } };
    runner.register(StepType.GithubApi, () => Promise.resolve(result));
    const step = await db.get(Collections.stepInstances, "step-1");
    await runner.dispatch(step!);
    const final = await db.get(Collections.stepInstances, "step-1");
    expect(final?.status).toBe(StepStatus.Completed);
    expect(final?.output).toEqual({ ok: true });
  });
});

describe("noopExecutor returns an empty output", () => {
  it("resolves with output: {} regardless of input", async () => {
    const result = await noopExecutor({
      ...makeBaseStepInstance(),
      id: "step-x",
      runId: "run-x",
      createdAt: 1,
      input: { anything: 1 },
    });
    expect(result.output).toEqual({});
  });
});
