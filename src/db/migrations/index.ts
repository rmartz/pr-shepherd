import type { Db } from "@/db";
import {
  applyMigrations,
  type Migration,
  type MigrationReport,
} from "./runner";
import * as workflowRunsInitial from "./workflowRuns/001-initial";

export { applyMigrations };
export type { Migration, MigrationReport };

export const MIGRATIONS: Record<string, Migration[]> = {
  workflowRuns: [workflowRunsInitial],
};

export async function runMigrations(db: Db): Promise<MigrationReport> {
  return applyMigrations(db, MIGRATIONS);
}
