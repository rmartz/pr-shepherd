import type { WorkflowGraph } from "@/config";
import { Collections } from "@/db/collections";
import { StepStatus, type StepInstance } from "@/db/schemas";
import type { Db } from "@/db/types";
import { advanceCompletedStep, type AdvanceResult } from "@/engine/advance";
import type { Runner } from "@/engine/runner";

// ---------------------------------------------------------------------------
// Execution tick (issue #284, part 2 — the orchestration half of the loop).
//
// The scheduler's admission tick transitions `pending → queued` under the
// concurrency caps. This is the complementary pass: it picks up the `queued`
// steps, runs each through the runner (`queued → running → completed|failed`),
// and — for a step that completed — advances the run to its routed next step
// (#284 part 1, `advanceCompletedStep`). Admission fills the queue; execution
// drains it and produces the next round of `pending` steps, which the next
// admission tick picks up. Together with `advanceCompletedStep` this is the
// engine's execution loop.
//
// This is the orchestration *logic*, parameterized by an injected `Runner`
// (exactly as the runner and advance units are injected/tested). The
// production wiring — assembling `createRunner` with the concrete step
// executors and their GitHub/Claude transports, and driving these ticks from
// the daemon's scheduler loop — is deferred: those transports do not exist yet
// (tracked as the remaining slice of #284).
//
// Concurrency: every queued step is dispatched concurrently and the tick awaits
// them all, so no step is left `queued` when the tick returns — a subsequent
// tick cannot re-dispatch a step already run. The admission cap bounds how many
// steps are `queued` at once, so the fan-out is bounded. A daemon that must not
// block admission while long steps run drives execution on its own cadence
// (the deferred wiring concern above).
// ---------------------------------------------------------------------------

export interface ExecutionDeps {
  db: Db;
  // The runner with step executors registered. Injected so the tick is testable
  // with a scripted executor and so production controls the executor registry.
  runner: Runner;
  // Resolve a run's workflow graph (for `advanceCompletedStep`'s routing).
  getGraph: (workflowId: string) => WorkflowGraph | undefined;
  // Retry budget for successor steps; forwarded to the advance. Defaults there.
  maxRetries?: number;
  newId?: () => string;
  now?: () => number;
}

// What one dispatched step did this tick.
export interface StepExecutionOutcome {
  stepInstanceId: string;
  // The step's terminal status after the runner ran it (`completed` or
  // `failed`).
  terminalStatus: StepStatus;
  // The advance result, present only when the step completed (a failed step
  // does not route onward — that is the routing layer's separate decision).
  advance?: AdvanceResult;
}

export interface ExecutionTickReport {
  executed: StepExecutionOutcome[];
}

// Run one queued step through the runner, then advance the run if it completed.
export async function dispatchAndAdvance(
  step: StepInstance,
  deps: ExecutionDeps,
): Promise<StepExecutionOutcome> {
  await deps.runner.dispatch(step);

  // Re-read: `dispatch` wrote the terminal status + output; the run's context
  // was merged by the runner before we advance off it.
  const fresh = await deps.db.get(Collections.stepInstances, step.id);
  const terminalStatus = fresh?.status ?? StepStatus.Failed;
  if (fresh?.status !== StepStatus.Completed) {
    return { stepInstanceId: step.id, terminalStatus };
  }
  // Fan-out children (#280) have no routing of their own — the join resumes
  // the parent once all children are terminal. Calling `advanceCompletedStep`
  // on a child would create a duplicate successor step and overwrite
  // `run.currentStepId` before the parent join fires, corrupting run state.
  if (fresh.parentStepId !== undefined) {
    return { stepInstanceId: step.id, terminalStatus };
  }

  const advance = await advanceCompletedStep(fresh, {
    db: deps.db,
    getGraph: deps.getGraph,
    maxRetries: deps.maxRetries,
    newId: deps.newId,
    now: deps.now,
  });
  return { stepInstanceId: step.id, terminalStatus, advance };
}

// Drain every `queued` step: dispatch each through the runner and advance the
// completed ones. Steps run concurrently; the tick awaits all before returning.
export async function runExecutionTick(
  deps: ExecutionDeps,
): Promise<ExecutionTickReport> {
  const queued = await deps.db.list(Collections.stepInstances, {
    status: StepStatus.Queued,
  });
  const executed = await Promise.all(
    queued.map((step) => dispatchAndAdvance(step, deps)),
  );
  return { executed };
}
