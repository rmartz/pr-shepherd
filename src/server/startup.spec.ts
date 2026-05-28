import { describe, it, expect, vi } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
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
    // Every collection in defaultMigrations should be stamped at v1 on
    // a fresh DB.
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
    ).toEqual([1]);
  });
});
