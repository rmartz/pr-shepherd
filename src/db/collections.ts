import {
  MetaDocSchema,
  RepositorySchema,
  WorkflowRunSchema,
  StepInstanceSchema,
  WorkflowDefinitionSchema,
  type MetaDoc,
  type Repository,
  type WorkflowRun,
  type StepInstance,
  type WorkflowDefinition,
} from "./schemas";
import type { CollectionDef } from "./types";

// Concrete collection definitions for each daemon-managed collection.
// Adapters key storage by `name`; runtime validation goes through `schema`.
// Kept in alphabetical order to minimize merge conflicts.
//
// The `meta` collection is internal — it holds one document per
// daemon-managed collection recording the highest applied migration
// version (see `src/db/migrations/`). Stored under the literal name
// `_meta` so it cannot collide with a user-facing collection.
export const Collections = {
  meta: {
    name: "_meta",
    schema: MetaDocSchema,
    idField: "id",
  } satisfies CollectionDef<MetaDoc>,
  repositories: {
    name: "repositories",
    schema: RepositorySchema,
    idField: "id",
  } satisfies CollectionDef<Repository>,
  stepInstances: {
    name: "stepInstances",
    schema: StepInstanceSchema,
    idField: "id",
  } satisfies CollectionDef<StepInstance>,
  workflowDefinitions: {
    name: "workflowDefinitions",
    schema: WorkflowDefinitionSchema,
    idField: "id",
  } satisfies CollectionDef<WorkflowDefinition>,
  workflowRuns: {
    name: "workflowRuns",
    schema: WorkflowRunSchema,
    idField: "id",
  } satisfies CollectionDef<WorkflowRun>,
} as const;
