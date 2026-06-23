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
import type { WaitProcess, SpawnFn } from "../waitExternal";

export interface FakeProcess extends WaitProcess {
  emitClose(code: number | null): void;
  emitError(err: Error): void;
  signals: string[];
}

export function makeFakeProcess(): FakeProcess {
  const closeListeners: ((code: number | null) => void)[] = [];
  const errorListeners: ((err: Error) => void)[] = [];
  const signals: string[] = [];

  const proc: FakeProcess = {
    signals,
    on(event, listener) {
      if (event === "close") {
        closeListeners.push(listener as (code: number | null) => void);
      } else {
        errorListeners.push(listener as (err: Error) => void);
      }
      return this;
    },
    kill(signal) {
      signals.push(signal);
      return true;
    },
    emitClose(code) {
      for (const l of closeListeners) l(code);
    },
    emitError(err) {
      for (const l of errorListeners) l(err);
    },
  };
  return proc;
}

export function makeSpawnFn(proc: FakeProcess): SpawnFn {
  return () => proc;
}

// Spawn fn that records the script path + args each call received, so a test
// can assert which wait-for-*.py the kind resolved to and the PR it keyed off.
export function makeCapturingSpawnFn(proc: FakeProcess): {
  spawn: SpawnFn;
  calls: { cmd: string; args: string[] }[];
} {
  const calls: { cmd: string; args: string[] }[] = [];
  return {
    spawn: (cmd, args) => {
      calls.push({ cmd, args });
      return proc;
    },
    calls,
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
    prNumber: 42,
    prTitle: "test pr",
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

export function makeBaseStep(): Omit<
  StepInstance,
  "id" | "runId" | "createdAt"
> {
  return {
    stepDefinitionId: "wait-ci",
    stepType: StepType.WaitExternal,
    status: StepStatus.Running,
    input: { kind: "ci", pr: 42 },
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

export function makeDb() {
  return createInMemoryDb();
}

export async function seedRun(db: Db): Promise<WorkflowRun> {
  const run = makeWorkflowRun();
  await db.create(Collections.workflowRuns, run);
  return run;
}

export async function seedStep(
  db: Db,
  overrides: Partial<StepInstance> = {},
): Promise<StepInstance> {
  const step: StepInstance = {
    ...makeBaseStep(),
    id: "step-1",
    runId: "run-1",
    createdAt: 1000,
    startedAt: 1100,
    ...overrides,
  };
  await db.create(Collections.stepInstances, step);
  return step;
}
