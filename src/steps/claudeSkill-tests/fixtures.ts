import { vi } from "vitest";
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
import type { SpawnedProcess } from "../claudeSkill";

export interface FakeChild {
  child: SpawnedProcess;
  kill: ReturnType<typeof vi.fn>;
  emitOut: (s: string) => void;
  emitErr: (s: string) => void;
  emitClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
  emitError: (err: Error) => void;
}

export function makeFakeChild(): FakeChild {
  let outCb: ((chunk: string) => void) | undefined;
  let errCb: ((chunk: string) => void) | undefined;
  let closeCb:
    | ((
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => void | Promise<void>)
    | undefined;
  let errorCb: ((err: Error) => void) | undefined;
  const kill = vi.fn((): boolean => true);
  const child = {
    stdout: {
      on: (event: "data", listener: (chunk: string) => void) => {
        outCb = listener;
      },
    },
    stderr: {
      on: (event: "data", listener: (chunk: string) => void) => {
        errCb = listener;
      },
    },
    on: (event: "close" | "error", listener: (...args: never[]) => void) => {
      if (event === "close")
        closeCb = listener as (
          code: number | null,
          signal: NodeJS.Signals | null,
        ) => void | Promise<void>;
      else errorCb = listener as (err: Error) => void;
    },
    kill,
  } as unknown as SpawnedProcess;
  return {
    child,
    kill,
    emitOut: (s) => outCb?.(s),
    emitErr: (s) => errCb?.(s),
    emitClose: (code, signal = null) => {
      void closeCb?.(code, signal);
    },
    emitError: (err) => errorCb?.(err),
  };
}

export function makeStep(overrides: Partial<StepInstance> = {}): StepInstance {
  return {
    id: "s1",
    runId: "run-1",
    stepDefinitionId: "review",
    stepType: StepType.ClaudeSkill,
    status: StepStatus.Running,
    input: { skill: "/review", args: ["7"] },
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1,
    startedAt: 2,
    metrics: { claudeMs: 0, activeMs: 0, scheduleWaitMs: 0, externalWaitMs: 0 },
    ...overrides,
  };
}

export function makeRun(): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: "owner/repo",
    prNumber: 7,
    prTitle: "test",
    status: RunStatus.Running,
    childRunIds: [],
    context: {},
    createdAt: 1,
    updatedAt: 1,
    metrics: {
      totalClaudeMs: 0,
      totalActiveMs: 0,
      totalScheduleWaitMs: 0,
      totalExternalWaitMs: 0,
    },
  };
}

export async function seedStep(
  db: Db,
  overrides: Partial<StepInstance> = {},
): Promise<StepInstance> {
  const step = makeStep(overrides);
  await db.create(Collections.stepInstances, step);
  return step;
}

export function makeDb() {
  return createInMemoryDb();
}
