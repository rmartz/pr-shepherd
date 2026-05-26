import type { Db } from "@/db";

export interface Migration {
  version: number;
  up: (db: Db) => Promise<void>;
}

export interface CollectionMigrationReport {
  collection: string;
  fromVersion: number;
  toVersion: number;
  migrationsRun: number;
}

export interface MigrationReport {
  collections: CollectionMigrationReport[];
}

// Applies pending migrations for each collection. Migrations are run in
// ascending version order. After each successful migration the collection's
// schemaVersion in _meta is bumped. A failed migration throws immediately,
// leaving the version unchanged so the daemon aborts startup with a clear
// error message.
export async function applyMigrations(
  db: Db,
  migrationsByCollection: Record<string, Migration[]>,
): Promise<MigrationReport> {
  const collections: CollectionMigrationReport[] = [];

  for (const [collection, migrations] of Object.entries(
    migrationsByCollection,
  )) {
    const seenVersions = new Set<number>();

    for (const migration of migrations) {
      if (seenVersions.has(migration.version)) {
        throw new Error(
          `Duplicate migration version ${String(migration.version)} for collection "${collection}"`,
        );
      }

      seenVersions.add(migration.version);
    }
  }

  for (const [collection, migrations] of Object.entries(
    migrationsByCollection,
  )) {
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    const meta = await db.getCollectionMeta(collection);
    const fromVersion = meta?.schemaVersion ?? 0;
    const pending = sorted.filter((m) => m.version > fromVersion);

    for (const migration of pending) {
      try {
        await migration.up(db);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Migration ${String(migration.version)} for collection "${collection}" failed: ${message}`,
          { cause: error },
        );
      }
      try {
        await db.setCollectionMeta(collection, {
          schemaVersion: migration.version,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to stamp schemaVersion ${String(migration.version)} for collection "${collection}": ${message}`,
          { cause: error },
        );
      }
    }

    const lastPending = pending[pending.length - 1];
    const toVersion =
      lastPending !== undefined ? lastPending.version : fromVersion;

    collections.push({
      collection,
      fromVersion,
      toVersion,
      migrationsRun: pending.length,
    });
  }

  return { collections };
}
