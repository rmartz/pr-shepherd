// Public surface of the daemon's operator-config module.
//
// Consumers import:
//   - `loadConfig` to read, parse, and validate `config.yaml`
//   - `ConfigError` to distinguish config failures from other errors
//   - `Config` / `RepositoryConfig` / `ConcurrencyConfig` types
//   - `ConfigSchema` for callers that already hold parsed YAML
//   - `DbAdapter` enum for the data-store adapter selection
export { loadConfig, ConfigError } from "./loader";
export {
  ConfigSchema,
  DbAdapter,
  type Config,
  type ConcurrencyConfig,
  type RepositoryConfig,
} from "./schema";
