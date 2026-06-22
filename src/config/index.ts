// Public surface of the daemon's operator-config module.
//
// Consumers import:
//   - `loadConfig` to read, parse, and validate `config.yaml`
//   - `ConfigError` to distinguish config failures from other errors
//   - `Config` / `RepositoryConfig` / `ConcurrencyConfig` types
//   - `ConfigSchema` for callers that already hold parsed YAML
//   - `DbAdapterKind` enum for the data-store adapter selection
export { loadConfig, ConfigError } from "./loader";
export {
  ConfigSchema,
  type Config,
  type ConcurrencyConfig,
  type RepositoryConfig,
} from "./schema";
export { DbAdapterKind } from "../db";
export {
  loadWorkflow,
  WorkflowLoadError,
  type RoutingRule,
  type WorkflowGraph,
  type WorkflowStep,
} from "./workflowLoader";
export {
  loadWorkflowRegistry,
  ReloadStatus,
  WorkflowRegistry,
  type RegistryLoadResult,
  type ReloadResult,
  type WorkflowRegistryOptions,
} from "./workflowRegistry";
export {
  startWorkflowWatcher,
  type StartWorkflowWatcherOptions,
  type WatcherSubscription,
  type WatchFactory,
  type WatchListener,
  type WorkflowWatcherHandle,
} from "./workflowWatcher";
