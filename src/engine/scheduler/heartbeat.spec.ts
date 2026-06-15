import { describe, it, expect } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import {
  RunStatus,
  StepStatus,
  StepType,
  type StepInstance,
} from "@/db/schemas";
import type { CollectionDef, Db, Filter, SubscriptionCallback } from "@/db/types";
import { monitorHeartbeats } from "./heartbeat";

function makeBaseStepInstance(): Omit<
  StepInstance,
  "id" | "runId" | "createdAt" | "startedAt" | "heartbeatAt"
> {
  return {
    stepDefinitionId: "step-x",
    stepType: StepType.ClaudeSkill,
    status: StepStatus.Pending,
    input: { payload: "v1" },
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

async function seedRun(db: Db): Promise<void> {
  await db.create(Collections.workflowRuns, {
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
  });
}

async function seedRunningStep(
  db: Db,
  args: {
    id: string;
    heartbeatAt: number;
    retryCount?: number;
    maxRetries?: number;
    input?: Record<string, unknown>;
  },
): Promise<void> {
  await db.create(Collections.stepInstances, {
    ...makeBaseStepInstance(),
    id: args.id,
    runId: "run-1",
    status: StepStatus.Running,
    input: args.input ?? { payload: "v1" },
    retryCount: args.retryCount ?? 0,
    maxRetries: args.maxRetries ?? 3,
    createdAt: 1000,
    startedAt: 2000,
    heartbeatAt: args.heartbeatAt,
  });
}

describe("monitorHeartbeats", () => {
  it("leaves a running step alone when heartbeat is fresh", async () => {
    const db = createInMemoryDb();
    await seedRun(db);
    await seedRunningStep(db, { id: "step-live", heartbeatAt: 95_000 });

    const failed = await monitorHeartbeats(db, {
      poll: { heartbeatIntervalSeconds: 15 },
      nowMs: () => 120_000,
    });

    expect(failed).toEqual([]);
    const liveStep = await db.get(Collections.stepInstances, "step-live");
    expect(liveStep?.status).toBe(StepStatus.Running);
  });

  it("fails a dead running step and creates a fresh pending retry under budget", async () => {
    const db = createInMemoryDb();
    await seedRun(db);
    await seedRunningStep(db, {
      id: "step-dead",
      heartbeatAt: 10_000,
      retryCount: 1,
      maxRetries: 3,
      input: { snapshot: { n: 1 } },
    });

    const failed = await monitorHeartbeats(db, {
      poll: { heartbeatIntervalSeconds: 15 },
      nowMs: () => 120_000,
      newStepId: () => "step-dead-retry-2",
    });

    expect(failed).toEqual([
      {
        stepInstanceId: "step-dead",
        retriedStepInstanceId: "step-dead-retry-2",
      },
    ]);

    const dead = await db.get(Collections.stepInstances, "step-dead");
    expect(dead?.status).toBe(StepStatus.Failed);
    expect(dead?.error).toBe("heartbeat_timeout");
    expect(dead?.completedAt).toBe(120_000);

    const retry = await db.get(Collections.stepInstances, "step-dead-retry-2");
    expect(retry?.status).toBe(StepStatus.Pending);
    expect(retry?.retryCount).toBe(2);
    expect(retry?.input).toEqual({ snapshot: { n: 1 } });
    expect(retry?.createdAt).toBe(120_000);
    expect(retry?.queuedAt).toBeUndefined();
    expect(retry?.startedAt).toBeUndefined();
    expect(retry?.waitingAt).toBeUndefined();
    expect(retry?.completedAt).toBeUndefined();
    expect(retry?.heartbeatAt).toBeUndefined();
  });

  it("fails a dead running step at retry budget without creating a retry", async () => {
    const db = createInMemoryDb();
    await seedRun(db);
    await seedRunningStep(db, {
      id: "step-budget",
      heartbeatAt: 10_000,
      retryCount: 3,
      maxRetries: 3,
    });

    const failed = await monitorHeartbeats(db, {
      poll: { heartbeatIntervalSeconds: 15 },
      nowMs: () => 120_000,
    });

    expect(failed).toEqual([{ stepInstanceId: "step-budget" }]);
    const allSteps = await db.list(Collections.stepInstances);
    expect(allSteps).toHaveLength(1);
    expect(allSteps[0]?.id).toBe("step-budget");
    expect(allSteps[0]?.status).toBe(StepStatus.Failed);
    expect(allSteps[0]?.error).toBe("heartbeat_timeout");
  });

  it("is idempotent across two monitor passes on the same dead step", async () => {
    const db = createInMemoryDb();
    await seedRun(db);
    await seedRunningStep(db, {
      id: "step-idempotent",
      heartbeatAt: 10_000,
      retryCount: 0,
      maxRetries: 1,
    });

    const first = await monitorHeartbeats(db, {
      poll: { heartbeatIntervalSeconds: 15 },
      nowMs: () => 120_000,
      newStepId: () => "step-idempotent-retry-1",
    });
    const second = await monitorHeartbeats(db, {
      poll: { heartbeatIntervalSeconds: 15 },
      nowMs: () => 120_000,
      newStepId: () => "step-idempotent-retry-2",
    });

    expect(first).toEqual([
      {
        stepInstanceId: "step-idempotent",
        retriedStepInstanceId: "step-idempotent-retry-1",
      },
    ]);
    expect(second).toEqual([]);
    const pending = await db.get(
      Collections.stepInstances,
      "step-idempotent-retry-1",
    );
    expect(pending?.retryCount).toBe(1);
    const allSteps = await db.list(Collections.stepInstances);
    expect(allSteps).toHaveLength(2);
  });

  it("uses an overridden timeout threshold when configured", async () => {
    const db = createInMemoryDb();
    await seedRun(db);
    await seedRunningStep(db, {
      id: "step-override",
      heartbeatAt: 90_000,
    });

    const failed = await monitorHeartbeats(db, {
      poll: { heartbeatIntervalSeconds: 15 },
      heartbeatTimeoutSeconds: 20,
      nowMs: () => 120_000,
    });

    expect(failed).toEqual([
      {
        stepInstanceId: "step-override",
        retriedStepInstanceId: expect.any(String),
      },
    ]);
  });

  it("skips a step whose heartbeat refreshed between list and re-read (TOCTOU guard)", async () => {
    const baseDb = createInMemoryDb();
    await seedRun(baseDb);
    await seedRunningStep(baseDb, { id: "step-racing", heartbeatAt: 10_000 });

    // Simulate a concurrent runner that refreshed heartbeatAt after the initial
    // list but before the per-step re-read inside monitorHeartbeats.
    const racingDb: Db = {
      get: async <T>(coll: CollectionDef<T>, id: string): Promise<T | undefined> => {
        const doc = await baseDb.get(coll, id);
        if (id === "step-racing" && doc !== undefined) {
          return {
            ...(doc as Record<string, unknown>),
            heartbeatAt: 115_000,
          } as unknown as T;
        }
        return doc;
      },
      list: <T>(coll: CollectionDef<T>, filter?: Filter<T>) =>
        baseDb.list(coll, filter),
      create: <T>(coll: CollectionDef<T>, doc: T) => baseDb.create(coll, doc),
      update: <T>(coll: CollectionDef<T>, id: string, patch: Partial<T>) =>
        baseDb.update(coll, id, patch),
      delete: <T>(coll: CollectionDef<T>, id: string) =>
        baseDb.delete(coll, id),
      subscribe: <T>(
        coll: CollectionDef<T>,
        filter: Filter<T> | undefined,
        onChange: SubscriptionCallback<T>,
      ) => baseDb.subscribe(coll, filter, onChange),
    };

    const failed = await monitorHeartbeats(racingDb, {
      poll: { heartbeatIntervalSeconds: 15 },
      nowMs: () => 120_000,
    });

    expect(failed).toEqual([]);
    const step = await baseDb.get(Collections.stepInstances, "step-racing");
    expect(step?.status).toBe(StepStatus.Running);
  });
});
