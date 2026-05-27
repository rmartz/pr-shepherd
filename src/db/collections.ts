import {
  RepositorySchema,
  WorkflowRunSchema,
  StepInstanceSchema,
  WorkflowDefinitionSchema,
  type Repository,
  type WorkflowRun,
  type StepInstance,
  type WorkflowDefinition,
} from "./schemas";
import type { CollectionDef } from "./types";

// Concrete collection definitions for each daemon-managed collection.
// Adapters key storage by `name`; runtime validation goes through `schema`.
// Kept in alphabetical order to minimize merge conflicts.
export const Collections = {
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
