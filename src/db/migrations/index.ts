import { Collections } from "../collections";
import type { Db } from "../types";

// A single forward-only migration script. Each migration is identified
// by a positive integer version; the runner sorts ascending before
// applying. `up` performs the data transformation and may use any
// method on the `Db` interface (typically `list` + `update`).
export interface Migration {
  version: number;
  up: (db: Db) => Promise<void>;
}

// Summary of a `runMigrations` invocation. Keyed by collection name;
// values are the versions actually applied this run (empty array means
// the collection was already up-to-date).
export interface MigrationReport {
  applied: Record<string, number[]>;
}

// Map of collection name → ordered (or unordered — the runner sorts)
// list of migrations for that collection. Callers compose this from
// the per-collection `migrations/{collection}/index.ts` aggregators.
export type MigrationsByCollection = Record<string, Migration[]>;

function validateMigrations(
  collectionName: string,
  migrations: Migration[],
): void {
  const seen = new Set<number>();
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new Error(
        `Migration for "${collectionName}" has invalid version ${String(m.version)} — versions must be positive integers.`,
      );
    }
    if (seen.has(m.version)) {
      throw new Error(
        `Migration for "${collectionName}" has duplicate version ${String(m.version)} — each version must be unique within a collection.`,
      );
    }
    seen.add(m.version);
  }
}

async function readCurrentVersion(
  db: Db,
  collectionName: string,
): Promise<number> {
  const meta = await db.get(Collections.meta, collectionName);
  return meta?.schemaVersion ?? 0;
}

async function stampVersion(
  db: Db,
  collectionName: string,
  version: number,
): Promise<void> {
  const now = Date.now();
  const existing = await db.get(Collections.meta, collectionName);
  if (existing === undefined) {
    await db.create(Collections.meta, {
      id: collectionName,
      schemaVersion: version,
      updatedAt: now,
    });
  } else {
    await db.update(Collections.meta, collectionName, {
      schemaVersion: version,
      updatedAt: now,
    });
  }
}

// Forward-only migrations runner. For each collection in
// `migrationsByCollection`:
//   1. Read the current stamped version from `_meta/{collection}`.
//   2. Run every migration whose version is greater than the stamp,
//      in ascending order.
//   3. After each successful `up()`, stamp the meta doc with that
//      migration's version. A failure aborts the entire run (including
//      remaining collections) with the original error, leaving the
//      meta doc at the last successfully-applied version.
//
// Idempotent: running twice in a row applies nothing the second time.
//
// Collections are processed in alphabetical order so failure behavior
// is deterministic across calls.
export async function runMigrations(
  db: Db,
  migrationsByCollection: MigrationsByCollection,
): Promise<MigrationReport> {
  const applied: Record<string, number[]> = {};
  const collectionNames = Object.keys(migrationsByCollection).sort();

  for (const collectionName of collectionNames) {
    const migrations = migrationsByCollection[collectionName] ?? [];
    validateMigrations(collectionName, migrations);
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    const currentVersion = await readCurrentVersion(db, collectionName);
    // Downgrade detection: if the stamped version is higher than any
    // migration this daemon knows about, the binary is older than the
    // schema (e.g. a deploy rolled back while the DB stayed forward).
    // Forward-only migrations can't safely run against an unknown
    // newer schema — abort startup rather than silently proceeding.
    const lastMigration = sorted[sorted.length - 1];
    const maxKnownVersion = lastMigration?.version ?? 0;
    if (currentVersion > maxKnownVersion) {
      throw new Error(
        `Unsupported downgrade for collection "${collectionName}": stamped schemaVersion ${String(currentVersion)} exceeds highest known migration ${String(maxKnownVersion)}. This daemon binary is older than the database schema; deploy a newer daemon or restore the database to a compatible version.`,
      );
    }
    const pending = sorted.filter((m) => m.version > currentVersion);
    applied[collectionName] = [];
    for (const migration of pending) {
      try {
        await migration.up(db);
      } catch (cause) {
        // Wrap with collection + version context so startup logs make
        // it obvious which migration failed without cross-referencing
        // line numbers. Preserve the original error via `cause` so the
        // stack trace and any structured fields remain available.
        throw new Error(
          `Migration failed for collection "${collectionName}" at version ${String(migration.version)}: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
      await stampVersion(db, collectionName, migration.version);
      applied[collectionName].push(migration.version);
    }
  }

  return { applied };
}
