import { Collections } from "@/db/collections";
import { StepStatus, type StepInstance } from "@/db/schemas";
import type { Db } from "@/db/types";
import type { StepExecutorRuntime } from "./types";

// ---------------------------------------------------------------------------
// Per-dispatch `StepExecutorRuntime` factory.
//
// `createStepExecutorRuntime` returns the handle the runner passes to an
// executor as its second argument. Both methods write through `Db.update`
// scoped to the single step the runner is dispatching, persisting the
// intermediate lifecycle state (`waiting` transition, heartbeat refresh,
// incremental `externalWaitMs`) that the return-only executor contract
// cannot express. See #78.
//
// The runner's terminal `completeStep`/`failStep` re-read the step before
// computing the metrics rollup, so any `waitingAt` and accumulated
// `externalWaitMs` written here are reflected in the final step and run
// metrics — the runtime does not touch the run-level rollup itself.
// ---------------------------------------------------------------------------

export function createStepExecutorRuntime(
  db: Db,
  step: StepInstance,
): StepExecutorRuntime {
  // Local to this dispatch: guards `enterWaiting` idempotency so a repeated
  // call does not overwrite the first `waitingAt`.
  let entered = false;
  // Running tally of the wait time accounted via `heartbeat(deltaMs)`, seeded
  // from the step's metrics at dispatch start so concurrent dispatches of the
  // same step id (e.g. a heartbeat-replacement retry) do not lose prior wait.
  let externalWaitMs = step.metrics.externalWaitMs;

  const enterWaiting = async (): Promise<void> => {
    if (entered) {
      return;
    }
    entered = true;
    await db.update(Collections.stepInstances, step.id, {
      status: StepStatus.Waiting,
      waitingAt: Date.now(),
    });
  };

  const heartbeat = async (deltaMs?: number): Promise<void> => {
    const heartbeatAt = Date.now();
    if (deltaMs === undefined) {
      await db.update(Collections.stepInstances, step.id, { heartbeatAt });
      return;
    }
    externalWaitMs += deltaMs;
    await db.update(Collections.stepInstances, step.id, {
      heartbeatAt,
      metrics: { ...step.metrics, externalWaitMs },
    });
  };

  return { enterWaiting, heartbeat };
}
