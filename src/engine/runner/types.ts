import type { StepInstance, StepType } from "@/db/schemas";

// ---------------------------------------------------------------------------
// Runner contracts. See vision §4.1 (Lifecycle of a Run) and §4.3 (Step
// Executors).
//
// An executor is a pure function over a step instance that returns an
// `output` object on success and rejects with an Error on failure. The
// runner owns the surrounding lifecycle: status transitions, heartbeat
// updates, context propagation, and error capture. Keeping the executor
// signature minimal lets Epic 4 plug each concrete executor in without
// each one re-implementing the wrapper boilerplate.
// ---------------------------------------------------------------------------

export interface ExecutorResult {
  // Step output to merge into the parent `workflowRun.context` on success.
  // Use `{}` when the step has no observable output (e.g. the noop placeholder).
  output: Record<string, unknown>;
}

export type StepExecutor = (step: StepInstance) => Promise<ExecutorResult>;

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
