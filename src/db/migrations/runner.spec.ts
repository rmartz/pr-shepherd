import { describe, it, expect, vi } from "vitest";
import { applyMigrations, type Migration } from "./runner";
import type { Db } from "@/db";

function makeDb(initialVersions: Record<string, number> = {}) {
  const metaStore: Record<string, number> = { ...initialVersions };
  const getCollectionMeta = vi.fn((collection: string) => {
    const version = metaStore[collection];
    return Promise.resolve(
      version !== undefined ? { schemaVersion: version } : undefined,
    );
  });
  const setCollectionMeta = vi.fn(
    (collection: string, meta: { schemaVersion: number }) => {
      metaStore[collection] = meta.schemaVersion;
      return Promise.resolve();
    },
  );
  const db: Db = { getCollectionMeta, setCollectionMeta };
  return { db, getCollectionMeta, setCollectionMeta };
}

function makeMigration(version: number): Migration {
  return { version, up: vi.fn().mockResolvedValue(undefined) };
}

describe("applyMigrations on a fresh DB runs all migrations", () => {
  it("runs every migration when no schemaVersion is stamped", async () => {
    const { db, setCollectionMeta } = makeDb();
    const m1 = makeMigration(1);
    const m2 = makeMigration(2);

    const report = await applyMigrations(db, { testCol: [m1, m2] });

    expect(m1.up).toHaveBeenCalledTimes(1);
    expect(m2.up).toHaveBeenCalledTimes(1);
    expect(setCollectionMeta).toHaveBeenCalledWith("testCol", {
      schemaVersion: 1,
    });
    expect(setCollectionMeta).toHaveBeenCalledWith("testCol", {
      schemaVersion: 2,
    });
    expect(report.collections).toHaveLength(1);
    expect(report.collections[0]).toMatchObject({
      collection: "testCol",
      fromVersion: 0,
      toVersion: 2,
      migrationsRun: 2,
    });
  });
});

describe("applyMigrations on a partially-migrated DB runs only newer migrations", () => {
  it("skips migrations at or below the stamped version", async () => {
    const { db } = makeDb({ testCol: 1 });
    const m1 = makeMigration(1);
    const m2 = makeMigration(2);
    const m3 = makeMigration(3);

    const report = await applyMigrations(db, { testCol: [m1, m2, m3] });

    expect(m1.up).not.toHaveBeenCalled();
    expect(m2.up).toHaveBeenCalledTimes(1);
    expect(m3.up).toHaveBeenCalledTimes(1);
    expect(report.collections[0]).toMatchObject({
      collection: "testCol",
      fromVersion: 1,
      toVersion: 3,
      migrationsRun: 2,
    });
  });
});

describe("applyMigrations when already fully up-to-date is a no-op", () => {
  it("runs no migrations and returns migrationsRun: 0 when version matches", async () => {
    const { db, setCollectionMeta } = makeDb({ testCol: 2 });
    const m1 = makeMigration(1);
    const m2 = makeMigration(2);

    const report = await applyMigrations(db, { testCol: [m1, m2] });

    expect(m1.up).not.toHaveBeenCalled();
    expect(m2.up).not.toHaveBeenCalled();
    expect(setCollectionMeta).not.toHaveBeenCalled();
    expect(report.collections[0]).toMatchObject({
      fromVersion: 2,
      toVersion: 2,
      migrationsRun: 0,
    });
  });
});

describe("applyMigrations when a migration throws does not bump the schema version", () => {
  it("throws a descriptive error and leaves schemaVersion unchanged", async () => {
    const { db, setCollectionMeta } = makeDb({ testCol: 1 });
    const failingMigration: Migration = {
      version: 2,
      up: vi.fn().mockRejectedValue(new Error("schema conflict")),
    };
    const m3 = makeMigration(3);

    await expect(
      applyMigrations(db, { testCol: [failingMigration, m3] }),
    ).rejects.toThrow(
      'Migration 2 for collection "testCol" failed: schema conflict',
    );

    expect(setCollectionMeta).not.toHaveBeenCalled();
    expect(m3.up).not.toHaveBeenCalled();
  });
});

describe("applyMigrations rejects duplicate migration versions before running anything", () => {
  it("throws a descriptive error when a collection contains duplicate versions", async () => {
    const { db, getCollectionMeta } = makeDb();
    const first = makeMigration(1);
    const second = makeMigration(1);

    await expect(
      applyMigrations(db, { testCol: [first, second] }),
    ).rejects.toThrow('Duplicate migration version 1 for collection "testCol"');

    expect(getCollectionMeta).not.toHaveBeenCalled();
    expect(first.up).not.toHaveBeenCalled();
    expect(second.up).not.toHaveBeenCalled();
  });
});

describe("applyMigrations when schemaVersion stamping fails wraps the error with context", () => {
  it("throws a descriptive error after a successful migration up", async () => {
    const migration = makeMigration(2);
    const setCollectionMeta = vi
      .fn()
      .mockRejectedValue(new Error("write rejected by Firestore"));
    const db: Db = {
      getCollectionMeta: vi.fn().mockResolvedValue({ schemaVersion: 1 }),
      setCollectionMeta,
    };

    await expect(applyMigrations(db, { testCol: [migration] })).rejects.toThrow(
      'Failed to stamp schemaVersion 2 for collection "testCol": write rejected by Firestore',
    );

    expect(migration.up).toHaveBeenCalledTimes(1);
    expect(setCollectionMeta).toHaveBeenCalledWith("testCol", {
      schemaVersion: 2,
    });
  });
});

describe("applyMigrations runs migrations in ascending version order regardless of input order", () => {
  it("applies version 1 before version 2 even when given in reverse order", async () => {
    const { db } = makeDb();
    const callOrder: number[] = [];
    const m1: Migration = {
      version: 1,
      up: vi.fn(() => {
        callOrder.push(1);
        return Promise.resolve();
      }),
    };
    const m2: Migration = {
      version: 2,
      up: vi.fn(() => {
        callOrder.push(2);
        return Promise.resolve();
      }),
    };

    await applyMigrations(db, { testCol: [m2, m1] });

    expect(callOrder).toEqual([1, 2]);
  });
});
