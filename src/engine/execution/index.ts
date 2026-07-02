// Execution tick (#284 part 2): drain `queued` steps through the runner and
// advance the completed ones. The orchestration half of the execution loop;
// pairs with `@/engine/advance` (part 1). Production wiring of the executor
// registry + daemon loop is the remaining, transport-blocked slice of #284.
export {
  dispatchAndAdvance,
  runExecutionTick,
  type ExecutionDeps,
  type ExecutionTickReport,
  type StepExecutionOutcome,
} from "./executionTick";
