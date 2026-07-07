// Step-level fan-out/fan-in primitive (#280): a step spawns N child steps
// (`spawnChildSteps` + `suspended`) and the scheduler joins it once they all
// finish (`runJoinTick`). The foundation for splitting a `github_api` batch
// into per-action steps (#281). See docs/subsystems/step-fan-out-fan-in.md.
export {
  spawnChildSteps,
  type FanOutChildSpec,
  type SpawnChildStepsOptions,
} from "./fanout";
export {
  runJoinTick,
  type JoinDeps,
  type JoinOutcome,
  type JoinTickReport,
} from "./join";
