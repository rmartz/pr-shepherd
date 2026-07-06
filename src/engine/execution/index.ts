// Execution tick (#284 part 2): drain `queued` steps through the runner and
// advance the completed ones. The orchestration half of the execution loop;
// pairs with `@/engine/advance` (part 1).
export {
  dispatchAndAdvance,
  runExecutionTick,
  type ExecutionDeps,
  type ExecutionTickReport,
  type StepExecutionOutcome,
} from "./executionTick";
// Executor-registry assembly (#290): wire every StepType to its production
// executor + transports into a ready-to-run Runner.
export { assembleRunner, type AssembleRunnerDeps } from "./assembleRunner";
