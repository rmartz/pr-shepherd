import { describe, it, expect, vi } from "vitest";
import type { WorkflowGraph } from "@/config";
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
import { createRunner, type StepExecutor } from "@/engine/runner";
import { runExecutionTick } from "./executionTick";

// ---------------------------------------------------------------------------
// Tests for the execution tick (#284 part 2). Driven through the *real*
// `createRunner` with a scripted executor, so the full chain — dispatch →
// terminal transition + context merge → advance — is exercised, not mocked.
// `advanceCompletedStep` (#284 part 1) and `createRunner` (#56) have their own
// tests; these assert the orchestration wires them together.
// ---------------------------------------------------------------------------

// `derive` routes to `act` when output.action == 'go', else terminates.
function makeGraph(): WorkflowGraph {
  return {
    id: "wf-test",
    version: 1,
    source: "",
    steps: [
      {
        id: "derive",
        stepType: StepType.DerivePrState,
        input: {},
        routing: [
          { condition: "output.action == 'go'", next: "act" },
          { condition: "true", next: undefined },
        ],
      },
      {
        id: "act",
        stepType: StepType.GithubApi,
        input: {},
        routing: [{ condition: "true", next: undefined }],
      },
    ],
  };
}

function makeRun(): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "wf-test",
    workflowVersion: 1,
    repo: "owner/repo",
    prNumber: 7,
    prTitle: "pr",
    status: RunStatus.Running,
    childRunIds: [],
    context: {},
    currentStepId: "derive-instance",
    createdAt: 1000,
    updatedAt: 1000,
    metrics: {
      totalClaudeMs: 0,
      totalActiveMs: 0,
      totalScheduleWaitMs: 0,
      totalExternalWaitMs: 0,
    },
  };
}

function makeStep(overrides: Partial<StepInstance> = {}): StepInstance {
  return {
    id: "derive-instance",
    runId: "run-1",
    stepDefinitionId: "derive",
    stepType: StepType.DerivePrState,
    status: StepStatus.Queued,
    input: {},
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1000,
    metrics: { claudeMs: 0, activeMs: 0, scheduleWaitMs: 0, externalWaitMs: 0 },
    ...overrides,
  };
}

async function seed(db: Db, step: StepInstance): Promise<void> {
  await db.create(Collections.workflowRuns, makeRun());
  await db.create(Collections.stepInstances, step);
}

function depsWith(db: Db, executor: StepExecutor) {
  const runner = createRunner(db);
  runner.register(StepType.DerivePrState, executor);
  return {
    db,
    runner,
    getGraph: (): WorkflowGraph => makeGraph(),
    newId: (): string => "act-instance",
    now: (): number => 5000,
  };
}

describe("runExecutionTick runs a queued step and advances the run", () => {
  it("completes the step and creates its routed successor", async () => {
    const db = createInMemoryDb();
    await seed(db, makeStep());
    const executor: StepExecutor = () =>
      Promise.resolve({ output: { action: "go" } });

    const report = await runExecutionTick(depsWith(db, executor));

    expect(report.executed).toHaveLength(1);
    expect(report.executed[0]).toMatchObject({
      stepInstanceId: "derive-instance",
      terminalStatus: StepStatus.Completed,
      advance: { kind: "advanced", nextStepDefinitionId: "act" },
    });
    const next = await db.get(Collections.stepInstances, "act-instance");
    expect(next).toMatchObject({
      stepDefinitionId: "act",
      status: StepStatus.Pending,
    });
  });
});

describe("runExecutionTick does not advance a failed step", () => {
  it("records the failure and creates no successor", async () => {
    const db = createInMemoryDb();
    await seed(db, makeStep());
    const executor: StepExecutor = () => Promise.reject(new Error("boom"));

    const report = await runExecutionTick(depsWith(db, executor));

    expect(report.executed[0]).toMatchObject({
      stepInstanceId: "derive-instance",
      terminalStatus: StepStatus.Failed,
    });
    expect(report.executed[0]?.advance).toBeUndefined();
    expect(
      await db.get(Collections.stepInstances, "act-instance"),
    ).toBeUndefined();
  });
});

describe("runExecutionTick only dispatches queued steps", () => {
  it("ignores a pending step that admission has not queued yet", async () => {
    const db = createInMemoryDb();
    await seed(db, makeStep({ status: StepStatus.Pending }));
    const executor = vi.fn<StepExecutor>(() => Promise.resolve({ output: {} }));

    const report = await runExecutionTick(depsWith(db, executor));

    expect(report.executed).toHaveLength(0);
    expect(executor).not.toHaveBeenCalled();
    const step = await db.get(Collections.stepInstances, "derive-instance");
    expect(step?.status).toBe(StepStatus.Pending);
  });
});
