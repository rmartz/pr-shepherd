import type { Db } from "@/db";

// Initial schema stamp for workflowRuns. Firestore is schemaless; this
// migration exists solely to record that the collection has been initialised
// at version 1 so future migrations can apply incrementally.
export const version = 1;

export function up(_db: Db): Promise<void> {
  void _db;
  // No structural changes required for the initial schema.
  return Promise.resolve();
}
