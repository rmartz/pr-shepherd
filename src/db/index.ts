import type {
  Repository,
  StepInstance,
  WorkflowDefinition,
  WorkflowRun,
} from "./schemas/index.js";
import { HostedFirestoreDb } from "./adapters/hostedFirestore.js";

export type {
  Repository,
  RepositorySchema,
  StepInstance,
  StepInstanceMetrics,
  StepInstanceSchema,
  StepStatus,
  StepType,
  WorkflowDefinition,
  WorkflowDefinitionSchema,
  WorkflowRun,
  WorkflowRunMetrics,
  WorkflowRunSchema,
  WorkflowRunStatus,
} from "./schemas/index.js";

export interface CollectionMap {
  repositories: Repository;
  stepInstances: StepInstance;
  workflowDefinitions: WorkflowDefinition;
  workflowRuns: WorkflowRun;
}

export type CollectionName = keyof CollectionMap;

export interface DbFilter<T> {
  field: keyof T & string;
  op: "==" | "!=" | "<" | "<=" | ">" | ">=";
  value: unknown;
}

export interface Db {
  get<C extends CollectionName>(
    collection: C,
    id: string,
  ): Promise<CollectionMap[C] | undefined>;

  list<C extends CollectionName>(
    collection: C,
    filters?: DbFilter<CollectionMap[C]>[],
  ): Promise<CollectionMap[C][]>;

  create<C extends CollectionName>(
    collection: C,
    doc: CollectionMap[C],
  ): Promise<CollectionMap[C]>;

  update<C extends CollectionName>(
    collection: C,
    id: string,
    patch: Partial<CollectionMap[C]>,
  ): Promise<CollectionMap[C]>;

  delete(collection: CollectionName, id: string): Promise<void>;

  subscribe<C extends CollectionName>(
    collection: C,
    filters: DbFilter<CollectionMap[C]>[] | undefined,
    onChange: (docs: CollectionMap[C][]) => void,
  ): () => void;
}

export type DbAdapterName =
  | "firebase-emulator"
  | "firebase-hosted"
  | "leveldb";

export interface DbConfig {
  adapter: DbAdapterName;
}

export function createDb(config: DbConfig): Db {
  switch (config.adapter) {
    case "firebase-hosted":
    case "firebase-emulator":
      return new HostedFirestoreDb();
    case "leveldb":
      throw new Error("LevelDB adapter not yet implemented");
    default: {
      const exhaustive: never = config.adapter;
      throw new Error(`Unknown db adapter: ${String(exhaustive)}`);
    }
  }
}
