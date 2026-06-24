// Public surface of the wait-set orchestration & stall/liveness subsystem
// (#110). PRs blocked on CI/Copilot drain through one shared bulk poll instead
// of holding a worker on a sleep; per-action hard timeouts, per-wait stall
// warnings, and a liveness watchdog defend against stalls and deadlock; and the
// graceful-drain path aggregates per-PR results on interrupt.
export {
  WaitKind,
  isCiCleared,
  isCopilotCleared,
  isWaitCleared,
} from "./clearance";
export {
  collectWaitSet,
  drainWaitSet,
  type WaitSetDrainOptions,
  type WaitSetDrainResult,
  type WaitSetEntry,
} from "./waitSet";
export {
  checkLiveness,
  watchdogTick,
  type LivenessConfig,
  type LivenessReport,
  type LivenessWatchdogConfig,
  type WatchdogState,
} from "./liveness";
export {
  aggregateDrainResults,
  type DrainAggregate,
  type PrDrainSummary,
} from "./drainAggregate";
