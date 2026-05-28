import { describe, it, expect, vi } from "vitest";
import { createInMemoryDb } from "../adapters/inMemory";
import { Collections } from "../collections";
import type { Db } from "../types";
import { runMigrations, type Migration } from "./index";

async function noop(): Promise<void> {
  await Promise.resolve();
}

// Pushes onto an array and yields once to satisfy the `require-await`
// lint without changing semantics — the tests only care about ordering.
function pushMigration(version: number, sink: number[]): Migration {
  return {
    version,
    up: async () => {
      sink.push(version);
      await Promise.resolve();
    },
  };
}

function throwingMigration(version: number, message: string): Migration {
  return {
    version,
    up: async () => {
      await Promise.resolve();
      throw new Error(message);
    },
  };
}

function makeMigration(
  version: number,
  up: (db: Db) => Promise<void> = noop,
): Migration {
  return { version, up };
}

describe("runMigrations on a fresh DB applies all migrations in order", () => {
  it("runs every migration when no meta doc exists", async () => {
    const db = createInMemoryDb();
    const order: number[] = [];
    const report = await runMigrations(db, {
      [Collections.workflowRuns.name]: [
        pushMigration(1, order),
        pushMigration(2, order),
      ],
    });
    expect(order).toEqual([1, 2]);
    expect(report.applied[Collections.workflowRuns.name]).toEqual([1, 2]);
  });

  it("stamps the meta doc with the highest applied version", async () => {
    const db = createInMemoryDb();
    await runMigrations(db, {
      [Collections.workflowRuns.name]: [makeMigration(1), makeMigration(2)],
    });
    const meta = await db.get(Collections.meta, Collections.workflowRuns.name);
    expect(meta?.schemaVersion).toBe(2);
  });

  it("sorts migrations ascending by version before running", async () => {
    const db = createInMemoryDb();
    const order: number[] = [];
    await runMigrations(db, {
      [Collections.workflowRuns.name]: [
        pushMigration(3, order),
        pushMigration(1, order),
        pushMigration(2, order),
      ],
    });
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("runMigrations on a partially-migrated DB applies only newer ones", () => {
  it("skips migrations whose version is at or below the stamped version", async () => {
    const db = createInMemoryDb();
    // Pre-stamp the collection at version 2.
    await db.create(Collections.meta, {
      id: Collections.workflowRuns.name,
      schemaVersion: 2,
      updatedAt: 1716700000000,
    });
    const run = vi.fn(noop);
    const report = await runMigrations(db, {
      [Collections.workflowRuns.name]: [
        makeMigration(1, run),
        makeMigration(2, run),
        makeMigration(3, run),
      ],
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(report.applied[Collections.workflowRuns.name]).toEqual([3]);
  });

  it("bumps the meta doc to the highest newly-applied version", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.meta, {
      id: Collections.workflowRuns.name,
      schemaVersion: 1,
      updatedAt: 1716700000000,
    });
    await runMigrations(db, {
      [Collections.workflowRuns.name]: [
        makeMigration(1),
        makeMigration(2),
        makeMigration(3),
      ],
    });
    const meta = await db.get(Collections.meta, Collections.workflowRuns.name);
    expect(meta?.schemaVersion).toBe(3);
  });
});

describe("runMigrations is idempotent", () => {
  it("running twice with the same migrations is a no-op on the second call", async () => {
    const db = createInMemoryDb();
    const run = vi.fn(noop);
    const migrations = {
      [Collections.workflowRuns.name]: [
        makeMigration(1, run),
        makeMigration(2, run),
      ],
    };
    await runMigrations(db, migrations);
    run.mockClear();
    const report = await runMigrations(db, migrations);
    expect(run).not.toHaveBeenCalled();
    expect(report.applied[Collections.workflowRuns.name]).toEqual([]);
  });
});

describe("runMigrations aborts on failure without bumping the version", () => {
  it("throws and leaves the meta doc unchanged when a migration fails", async () => {
    const db = createInMemoryDb();
    const order: number[] = [];
    await expect(
      runMigrations(db, {
        [Collections.workflowRuns.name]: [
          pushMigration(1, order),
          throwingMigration(2, "boom"),
          pushMigration(3, order),
        ],
      }),
    ).rejects.toThrow(/boom/);
    expect(order).toEqual([1]);
    const meta = await db.get(Collections.meta, Collections.workflowRuns.name);
    // Version 1 succeeded so the meta should reflect that; version 2
    // failed so the runner aborted before stamping it.
    expect(meta?.schemaVersion).toBe(1);
  });

  it("aborts the run when the first collection's first migration fails", async () => {
    const db = createInMemoryDb();
    await expect(
      runMigrations(db, {
        // Collections are processed alphabetically; "_meta" < "workflowRuns"
        // but the runner only touches names from the input map. Here we
        // give it only one collection so ordering is irrelevant.
        [Collections.workflowRuns.name]: [throwingMigration(1, "boom")],
      }),
    ).rejects.toThrow(/boom/);
    const meta = await db.get(Collections.meta, Collections.workflowRuns.name);
    expect(meta).toBeUndefined();
  });

  it("wraps the failing migration's error with collection name and version context", async () => {
    const db = createInMemoryDb();
    try {
      await runMigrations(db, {
        [Collections.workflowRuns.name]: [throwingMigration(7, "boom")],
      });
      throw new Error("expected runMigrations to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const wrapped = err as Error & { cause?: unknown };
      expect(wrapped.message).toContain("workflowRuns");
      expect(wrapped.message).toContain("7");
      expect(wrapped.message).toContain("boom");
      expect(wrapped.cause).toBeInstanceOf(Error);
      expect((wrapped.cause as Error).message).toBe("boom");
    }
  });
});

describe("runMigrations rejects malformed migration sets", () => {
  it("throws when two migrations share a version", async () => {
    const db = createInMemoryDb();
    await expect(
      runMigrations(db, {
        [Collections.workflowRuns.name]: [makeMigration(1), makeMigration(1)],
      }),
    ).rejects.toThrow(/duplicate/i);
  });

  it("throws when a migration version is not a positive integer", async () => {
    const db = createInMemoryDb();
    await expect(
      runMigrations(db, {
        [Collections.workflowRuns.name]: [makeMigration(0)],
      }),
    ).rejects.toThrow(/version/i);
  });
});

describe("runMigrations aborts on downgrade (stamped version newer than binary)", () => {
  it("throws with a clear error when the stamped version exceeds the highest known migration", async () => {
    const db = createInMemoryDb();
    // DB was migrated to v5 by a newer daemon; this binary only knows
    // up to v2 — running forward-only migrations against an unknown
    // newer schema would be unsafe.
    await db.create(Collections.meta, {
      id: Collections.workflowRuns.name,
      schemaVersion: 5,
      updatedAt: 1716700000000,
    });
    await expect(
      runMigrations(db, {
        [Collections.workflowRuns.name]: [makeMigration(1), makeMigration(2)],
      }),
    ).rejects.toThrow(/Unsupported downgrade.*workflowRuns.*5.*2/);
  });

  it("throws when the binary has no migrations for the collection but the DB is stamped at any version", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.meta, {
      id: Collections.workflowRuns.name,
      schemaVersion: 1,
      updatedAt: 1716700000000,
    });
    await expect(
      runMigrations(db, {
        [Collections.workflowRuns.name]: [],
      }),
    ).rejects.toThrow(/Unsupported downgrade/);
  });
});
