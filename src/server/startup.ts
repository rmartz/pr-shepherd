import type { Db } from "@/db";
import { runMigrations } from "@/db/migrations";

export async function startDaemon(db: Db): Promise<void> {
  await runMigrations(db);
}
