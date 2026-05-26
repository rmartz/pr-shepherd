import type { Db } from "@/db";

export interface Migration {
  version: number;
  /**
   * Apply this migration to the database.
   *
   * **Must be idempotent**: if `up` succeeds but the subsequent
   * `schemaVersion` stamp fails, the next startup will re-run this migration.
   * Implementations must therefore be safe to apply more than once without
   * changing the end state.
   */
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
      if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
        throw new Error(
          `Invalid migration version ${String(migration.version)} for collection "${collection}": must be a positive integer`,
        );
      }

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

    const highestAvailable = sorted[sorted.length - 1];
    if (
      sorted.length > 0 &&
      highestAvailable !== undefined &&
      fromVersion > highestAvailable.version
    ) {
      throw new Error(
        `Unsupported downgrade: collection "${collection}" is at schema version ${String(fromVersion)} but highest available migration is ${String(highestAvailable.version)}`,
      );
    }

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
