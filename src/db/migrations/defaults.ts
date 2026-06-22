import { Collections } from "../collections";
import type { MigrationsByCollection } from "./index";
import { commandsMigrations } from "./commands";
import { repositoriesMigrations } from "./repositories";
import { stepInstancesMigrations } from "./stepInstances";
import { workflowDefinitionsMigrations } from "./workflowDefinitions";
import { workflowRunsMigrations } from "./workflowRuns";

// Default migrations registry consumed by `startDaemon()` at startup.
// Per-collection arrays live under `migrations/{collection}/`; this
// module aggregates them keyed by the collection's runtime name so the
// runner can look them up against the `_meta` doc.
//
// Kept in alphabetical order to minimize merge conflicts.
export const defaultMigrations: MigrationsByCollection = {
  [Collections.commands.name]: commandsMigrations,
  [Collections.repositories.name]: repositoriesMigrations,
  [Collections.stepInstances.name]: stepInstancesMigrations,
  [Collections.workflowDefinitions.name]: workflowDefinitionsMigrations,
  [Collections.workflowRuns.name]: workflowRunsMigrations,
};
