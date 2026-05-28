import { Collections } from "@/db/collections";
import { StepStatus, type StepInstance, type StepType } from "@/db/schemas";
import type { Db } from "@/db/types";
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
//   3. Invokes the executor, awaiting its result.
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
    await db.update(Collections.stepInstances, step.id, {
      status: StepStatus.Running,
      startedAt,
      heartbeatAt: startedAt,
    });

    const executor = registry[step.stepType];
    if (executor === undefined) {
      await failStep(
        db,
        step,
        `no executor registered for stepType ${step.stepType}`,
      );
      return;
    }

    let result: ExecutorResult;
    try {
      result = await executor(step);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failStep(db, step, message);
      return;
    }

    await completeStep(db, step, result);
  };

  return { register, dispatch };
}

async function completeStep(
  db: Db,
  step: StepInstance,
  result: ExecutorResult,
): Promise<void> {
  const completedAt = Date.now();
  await db.update(Collections.stepInstances, step.id, {
    status: StepStatus.Completed,
    output: result.output,
    completedAt,
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
    updatedAt: completedAt,
  });
}

async function failStep(
  db: Db,
  step: StepInstance,
  message: string,
): Promise<void> {
  await db.update(Collections.stepInstances, step.id, {
    status: StepStatus.Failed,
    error: message,
    retryCount: step.retryCount + 1,
    completedAt: Date.now(),
  });
}
