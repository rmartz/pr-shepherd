import { describe, it, expect, vi } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { StepStatus, StepType } from "@/db/schemas";
import { startDaemon } from "./startup";

async function noop(): Promise<void> {
  await Promise.resolve();
}

describe("startDaemon runs migrations before returning", () => {
  it("invokes every pending migration in the registry", async () => {
    const db = createInMemoryDb();
    const ran = vi.fn(noop);
    const result = await startDaemon(db, {
      migrations: {
        [Collections.workflowRuns.name]: [{ version: 1, up: ran }],
      },
    });
    expect(ran).toHaveBeenCalledTimes(1);
    expect(
      result.migrationReport.applied[Collections.workflowRuns.name],
    ).toEqual([1]);
    expect(result.crashRecoveryReport).toEqual({
      demotedQueuedStepIds: [],
      staleRunningStepIds: [],
      warnedRunningSteps: [],
      failedOrphanRunIds: [],
    });
  });

  it("propagates a migration failure so the daemon can abort startup", async () => {
    const db = createInMemoryDb();
    await expect(
      startDaemon(db, {
        migrations: {
          [Collections.workflowRuns.name]: [
            {
              version: 1,
              up: async () => {
                await Promise.resolve();
                throw new Error("startup boom");
              },
            },
          ],
        },
      }),
    ).rejects.toThrow(/startup boom/);
  });
});

describe("startDaemon uses the default migrations registry when no override is passed", () => {
  it("applies the baseline migration for every daemon-managed collection", async () => {
    const db = createInMemoryDb();
    const result = await startDaemon(db);
    // Every collection in defaultMigrations should be stamped on a fresh DB:
    // the baseline v1 for each, plus workflowRuns' v2 paused backfill (#121).
    expect(result.migrationReport.applied[Collections.commands.name]).toEqual([
      1,
    ]);
    expect(
      result.migrationReport.applied[Collections.repositories.name],
    ).toEqual([1]);
    expect(
      result.migrationReport.applied[Collections.stepInstances.name],
    ).toEqual([1]);
    expect(
      result.migrationReport.applied[Collections.workflowDefinitions.name],
    ).toEqual([1]);
    expect(
      result.migrationReport.applied[Collections.workflowRuns.name],
    ).toEqual([1, 2]);
  });
});

describe("startDaemon runs crash recovery after migrations", () => {
  it("demotes queued steps created by a migration in the same startup pass", async () => {
    const db = createInMemoryDb();
    const result = await startDaemon(db, {
      migrations: {
        [Collections.stepInstances.name]: [
          {
            version: 1,
            up: async (db) => {
              await db.create(Collections.stepInstances, {
                id: "queued-step",
                runId: "run-1",
                stepDefinitionId: "step-a",
                stepType: StepType.ClaudeSkill,
                status: StepStatus.Queued,
                input: {},
                output: {},
                logs: [],
                retryCount: 0,
                maxRetries: 3,
                createdAt: 1000,
                metrics: {
                  claudeMs: 0,
                  activeMs: 0,
                  scheduleWaitMs: 0,
                  externalWaitMs: 0,
                },
              });
            },
          },
        ],
      },
    });

    expect(result.crashRecoveryReport.demotedQueuedStepIds).toEqual([
      "queued-step",
    ]);
    const step = await db.get(Collections.stepInstances, "queued-step");
    expect(step?.status).toBe(StepStatus.Pending);
  });
});
