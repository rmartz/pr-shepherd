import type { StepInstance, StepType } from "@/db/schemas";

// ---------------------------------------------------------------------------
// Runner contracts. See vision §4.1 (Lifecycle of a Run) and §4.3 (Step
// Executors).
//
// An executor is a function over a step instance that returns an `output`
// object on success and rejects with an Error on failure. The runner owns
// the surrounding lifecycle: the queued → running → completed|failed status
// transitions, the start/terminal writes, context propagation, and error
// capture. Keeping the terminal contract minimal lets Epic 4 plug each
// concrete executor in without re-implementing the wrapper boilerplate.
//
// Long-running `wait_*` executors additionally need to persist *intermediate*
// lifecycle state — a `running → waiting` transition and a periodic heartbeat
// so the heartbeat monitor (#58) does not declare them dead — which a
// return-only contract cannot express. The runner therefore passes a
// `StepExecutorRuntime` handle as the second argument; executors that do not
// need it simply ignore it. See #78.
// ---------------------------------------------------------------------------

export interface ExecutorResult {
  // Step output to merge into the parent `workflowRun.context` on success.
  // Use `{}` when the step has no observable output (e.g. the noop placeholder).
  output: Record<string, unknown>;
}

// Per-dispatch handle the runner gives each executor so it can persist
// intermediate lifecycle state mid-execution. Each method is bound to the
// step currently being dispatched and writes through the runner's `Db.update`.
export interface StepExecutorRuntime {
  // Persist a `running → waiting` transition, recording `waitingAt` at the
  // current time. Idempotent: the first call records the transition and
  // timestamp; later calls are no-ops, so the original `waitingAt` survives
  // even if the executor calls it more than once.
  enterWaiting: () => Promise<void>;
  // Refresh `heartbeatAt` to the current time so the heartbeat monitor sees
  // the step as live. When `deltaMs` is supplied, the same write also adds it
  // to `metrics.externalWaitMs`, letting a poll loop account its wait time
  // incrementally; omitting `deltaMs` refreshes the heartbeat only.
  heartbeat: (deltaMs?: number) => Promise<void>;
}

export type StepExecutor = (
  step: StepInstance,
  runtime: StepExecutorRuntime,
) => Promise<ExecutorResult>;

// Map of stepType → executor. Partial because not every type need be
// registered at any given moment (e.g. tests register a single executor).
export type ExecutorMap = Partial<Record<StepType, StepExecutor>>;

export interface Runner {
  // Register an executor for a stepType. Idempotent overwrite — calling
  // twice for the same stepType replaces the prior executor. The Epic 3
  // engine wires registrations once at startup; tests register inline.
  register: (stepType: StepType, executor: StepExecutor) => void;
  // Dispatch a queued step: transition queued → running → completed|failed,
  // invoke the registered executor, merge output into the run context on
  // success, capture the error and bump retryCount on failure. See
  // `createRunner` for the implementation.
  dispatch: (step: StepInstance) => Promise<void>;
}
