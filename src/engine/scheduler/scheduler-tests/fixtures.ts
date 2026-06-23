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
import type { SchedulerConfig } from "../loop";

export function makeConfig(): SchedulerConfig {
  return {
    concurrency: {
      systemMax: 8,
      githubApiMax: 4,
      defaultRepoMax: 2,
    },
    heartbeat: {
      intervalSeconds: 15,
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

export function makeWorkflowRun(
  overrides: Partial<WorkflowRun> = {},
): WorkflowRun {
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

export function makeDb() {
  return createInMemoryDb();
}

export async function seedRun(
  db: Db,
  overrides: Partial<WorkflowRun> = {},
): Promise<WorkflowRun> {
  const run = makeWorkflowRun(overrides);
  await db.create(Collections.workflowRuns, run);
  return run;
}

export async function seedPendingStep(
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

export async function seedRunningStepWithHeartbeat(
  db: Db,
  args: {
    id: string;
    runId: string;
    heartbeatAt: number;
  },
): Promise<void> {
  const step: StepInstance = {
    ...makeBaseStepInstance(),
    id: args.id,
    runId: args.runId,
    status: StepStatus.Running,
    createdAt: 1000,
    startedAt: 2000,
    heartbeatAt: args.heartbeatAt,
  };
  await db.create(Collections.stepInstances, step);
}

export async function seedActiveStep(
  db: Db,
  args: {
    id: string;
    runId: string;
    stepType: StepType;
    createdAt: number;
    status?: StepStatus.Running | StepStatus.Waiting;
  },
): Promise<void> {
  const step: StepInstance = {
    ...makeBaseStepInstance(),
    id: args.id,
    runId: args.runId,
    stepType: args.stepType,
    status: args.status ?? StepStatus.Running,
    createdAt: args.createdAt,
    startedAt: args.createdAt + 1,
  };
  await db.create(Collections.stepInstances, step);
}
