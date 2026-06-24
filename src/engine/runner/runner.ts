import { Collections } from "@/db/collections";
import { StepStatus, type StepInstance, type StepType } from "@/db/schemas";
import type { Db } from "@/db/types";
import {
  computeStepMetrics,
  runMetricIncrements,
} from "@/engine/metrics/rollup";
import { createStepExecutorRuntime } from "./runtime";
import type {
  ExecutorMap,
  Runner,
  StepExecutor,
  ExecutorResult,
} from "./types";

// ---------------------------------------------------------------------------
// Runner factory.
//
// `createRunner` returns a `Runner` whose `dispatch(step)` method:
//   1. Transitions the step `queued → running` and sets `heartbeatAt = now`
//      and `startedAt = now`. The heartbeat field is what the (separate)
//      heartbeat monitor sub-issue uses to detect dead runs after a daemon
//      restart — setting it eagerly at dispatch start is correct.
//   2. Looks up the registered executor for `step.stepType`. An unknown
//      stepType is a hard failure (`failed` with a clear message); it is
//      never silently dropped because the surrounding orchestrator cannot
//      route a step it does not understand.
//   3. Invokes the executor with a per-dispatch `StepExecutorRuntime`
//      handle (see `createStepExecutorRuntime`), awaiting its result. The
//      handle lets long-running `wait_*` executors persist a `waiting`
//      transition and periodic heartbeats mid-execution; the terminal
//      re-read in `completeStep`/`failStep` picks up whatever it wrote.
//   4. On success: writes `status: completed`, `output`, and `completedAt`,
//      then merges the executor's `output` into the parent run's `context`
//      via a second `Db.update`. The merge is shallow — top-level keys in
//      `output` win over existing run-context keys. (Deep-merge semantics
//      are a routing-DSL concern, #57.)
//   5. On failure: writes `status: failed`, the error message, an
//      incremented `retryCount`, and `completedAt`. Whether to retry is a
//      separate decision owned by the routing layer (#57) — the runner's
//      job ends at "record the failure faithfully".
//
// `register(stepType, executor)` mutates the internal executor map. The
// engine's startup code registers once; tests register inline. The Runner
// is intentionally a thin object with no long-lived state besides this
// map — restart safety lives in the scheduler (#55) and the heartbeat
// monitor (separate sub-issue).
// ---------------------------------------------------------------------------

export function createRunner(db: Db, executors: ExecutorMap = {}): Runner {
  const registry: ExecutorMap = { ...executors };

  const register = (stepType: StepType, executor: StepExecutor): void => {
    registry[stepType] = executor;
  };

  const dispatch = async (step: StepInstance): Promise<void> => {
    const startedAt = Date.now();
    const runningStep: StepInstance = {
      ...step,
      status: StepStatus.Running,
      startedAt,
      heartbeatAt: startedAt,
    };
    await db.update(Collections.stepInstances, step.id, {
      status: StepStatus.Running,
      startedAt,
      heartbeatAt: startedAt,
    });

    const executor = registry[step.stepType];
    if (executor === undefined) {
      await failStep(
        db,
        runningStep,
        `no executor registered for stepType ${step.stepType}`,
      );
      return;
    }

    const runtime = createStepExecutorRuntime(db, runningStep);
    let result: ExecutorResult;
    try {
      result = await executor(runningStep, runtime);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failStep(db, runningStep, message);
      return;
    }

    await completeStep(db, runningStep, result);
  };

  return { register, dispatch };
}

async function completeStep(
  db: Db,
  step: StepInstance,
  result: ExecutorResult,
): Promise<void> {
  const completedAt = Date.now();
  // Re-read the step before computing the terminal delta so any
  // `waitingAt` (or other lifecycle timestamp) the executor wrote
  // during execution is reflected in the rollup. Proper executor-side
  // heartbeat / waiting persistence is tracked in #78; once that lands,
  // executors that need to mark themselves `waiting` will do so via the
  // runtime handle and the re-read here will pick it up.
  const fresh = (await db.get(Collections.stepInstances, step.id)) ?? step;
  const stepDelta = computeStepMetrics({ ...fresh, completedAt });
  const nextStepMetrics = addStepDelta(fresh.metrics, stepDelta);
  await db.update(Collections.stepInstances, step.id, {
    status: StepStatus.Completed,
    output: result.output,
    completedAt,
    metrics: nextStepMetrics,
  });
  // Merge the step's output into the parent run's context. We re-read
  // the run rather than relying on the step's stale `runId` snapshot
  // because another step on the same run may have committed context
  // updates between dispatch start and our completion. Last-writer-wins
  // at the top-level key is acceptable for Epic 3; per-key conflict
  // resolution belongs to the routing DSL (#57).
  const run = await db.get(Collections.workflowRuns, step.runId);
  if (run === undefined) {
    // The parent run was deleted while the step was executing — an
    // inconsistency the runner cannot repair. Surfacing it requires a
    // separate reconciliation pass; we have already recorded the
    // step's completion so no data is lost.
    return;
  }
  await db.update(Collections.workflowRuns, step.runId, {
    context: { ...run.context, ...result.output },
  });
  // Roll the step's delta into the run total with an atomic `increment`
  // rather than a read-modify-write `update`, so concurrent completions on
  // the same run never drop a delta (#79). The context merge above is a
  // separate concern with its own last-writer-wins semantics (#57).
  await db.increment(
    Collections.workflowRuns,
    step.runId,
    runMetricIncrements(stepDelta),
    { updatedAt: completedAt },
  );
}

async function failStep(
  db: Db,
  step: StepInstance,
  message: string,
): Promise<void> {
  const completedAt = Date.now();
  // Same re-read pattern as completeStep: pick up any `waitingAt` the
  // executor managed to persist before failing. See #78.
  const fresh = (await db.get(Collections.stepInstances, step.id)) ?? step;
  const stepDelta = computeStepMetrics({ ...fresh, completedAt });
  const nextStepMetrics = addStepDelta(fresh.metrics, stepDelta);
  await db.update(Collections.stepInstances, step.id, {
    status: StepStatus.Failed,
    error: message,
    retryCount: fresh.retryCount + 1,
    completedAt,
    metrics: nextStepMetrics,
  });
  // Existence check only: the parent run may have been deleted while the step
  // executed. `increment` would throw on a missing doc, and an orphaned step
  // is an inconsistency the runner cannot repair — we have already recorded
  // the failure, so skip the rollup rather than crash.
  const run = await db.get(Collections.workflowRuns, step.runId);
  if (run === undefined) {
    return;
  }
  // Atomic `increment` rather than read-modify-write `update`, so concurrent
  // terminal completions on the same run never drop a delta (#79).
  await db.increment(
    Collections.workflowRuns,
    step.runId,
    runMetricIncrements(stepDelta),
    { updatedAt: completedAt },
  );
}

function addStepDelta(
  current: StepInstance["metrics"],
  delta: StepInstance["metrics"],
): StepInstance["metrics"] {
  return {
    claudeMs: current.claudeMs + delta.claudeMs,
    activeMs: current.activeMs + delta.activeMs,
    scheduleWaitMs: current.scheduleWaitMs + delta.scheduleWaitMs,
    externalWaitMs: current.externalWaitMs + delta.externalWaitMs,
  };
}
