import { Collections } from "@/db/collections";
import { StepStatus, type StepInstance } from "@/db/schemas";
import type { Db } from "@/db/types";

export interface HeartbeatMonitorConfig {
  poll: {
    heartbeatIntervalSeconds: number;
  };
  heartbeatTimeoutSeconds?: number;
  nowMs?: () => number;
  newStepId?: () => string;
}

export interface HeartbeatFailure {
  stepInstanceId: string;
  retriedStepInstanceId?: string;
}

const HEARTBEAT_TIMEOUT_ERROR = "heartbeat_timeout";

export async function monitorHeartbeats(
  db: Db,
  config: HeartbeatMonitorConfig,
): Promise<HeartbeatFailure[]> {
  const nowMs = config.nowMs ?? Date.now;
  const currentTimeMs = nowMs();
  const timeoutSeconds =
    config.heartbeatTimeoutSeconds ?? config.poll.heartbeatIntervalSeconds * 4;
  const staleBeforeMs = currentTimeMs - timeoutSeconds * 1000;
  const running = await db.list(Collections.stepInstances, {
    status: StepStatus.Running,
  });
  const stale = running.filter(
    (step) =>
      step.heartbeatAt !== undefined && step.heartbeatAt < staleBeforeMs,
  );
  if (stale.length === 0) {
    return [];
  }

  const failures: HeartbeatFailure[] = [];
  for (const step of stale) {
    await db.update(Collections.stepInstances, step.id, {
      status: StepStatus.Failed,
      error: HEARTBEAT_TIMEOUT_ERROR,
      completedAt: currentTimeMs,
    });

    let retriedStepInstanceId: string | undefined;
    if (step.retryCount < step.maxRetries) {
      retriedStepInstanceId = config.newStepId?.() ?? crypto.randomUUID();
      await db.create(
        Collections.stepInstances,
        makePendingRetryStep(step, retriedStepInstanceId, currentTimeMs),
      );
    }

    failures.push({
      stepInstanceId: step.id,
      retriedStepInstanceId,
    });
  }
  return failures;
}

function makePendingRetryStep(
  failedStep: StepInstance,
  stepId: string,
  createdAtMs: number,
): StepInstance {
  return {
    id: stepId,
    runId: failedStep.runId,
    stepDefinitionId: failedStep.stepDefinitionId,
    stepType: failedStep.stepType,
    status: StepStatus.Pending,
    input: failedStep.input,
    output: {},
    logs: [],
    retryCount: failedStep.retryCount + 1,
    maxRetries: failedStep.maxRetries,
    createdAt: createdAtMs,
    metrics: {
      claudeMs: 0,
      activeMs: 0,
      scheduleWaitMs: 0,
      externalWaitMs: 0,
    },
  };
}
