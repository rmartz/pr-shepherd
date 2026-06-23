import type { StepExecutorRuntime } from "../types";

// A no-op `StepExecutorRuntime` for unit tests that invoke an executor
// directly (outside the runner) and do not care about the intermediate
// lifecycle persistence. Executors that exercise the runtime — `wait_*` —
// supply their own recording stub or the real `createStepExecutorRuntime`.
export function makeNoopRuntime(): StepExecutorRuntime {
  return {
    enterWaiting: () => Promise.resolve(),
    heartbeat: () => Promise.resolve(),
  };
}
