import { defaultMigrations } from "@/db/migrations/defaults";
import {
  runMigrations,
  type MigrationReport,
  type MigrationsByCollection,
} from "@/db/migrations";
import type { Db } from "@/db/types";
import { recoverFromCrash, type CrashRecoveryReport } from "@/engine/recovery";

export interface StartDaemonOptions {
  // Override the default migrations registry. Tests pass a synthetic
  // map; production callers omit this and get the aggregated set from
  // `src/db/migrations/{collection}/`.
  migrations?: MigrationsByCollection;
}

export interface StartDaemonResult {
  migrationReport: MigrationReport;
  crashRecoveryReport: CrashRecoveryReport;
}

// Daemon startup entry point. Currently runs the migrations runner
// before any executor work begins (per Vision §7). Will grow to wire
// up additional startup tasks (engine boot, executor registration) as
// later epics land.
//
// A failure inside `runMigrations` propagates here unchanged so the
// daemon process can crash with a clear error rather than continuing
// against a partially-migrated database.
export async function startDaemon(
  db: Db,
  options: StartDaemonOptions = {},
): Promise<StartDaemonResult> {
  const migrationReport = await runMigrations(
    db,
    options.migrations ?? defaultMigrations,
  );
  const crashRecoveryReport = await recoverFromCrash(db);
  return { migrationReport, crashRecoveryReport };
}
