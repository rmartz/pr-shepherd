import { Collections } from "@/db/collections";
import { RunStatus, StepStatus } from "@/db/schemas";
import type { Db } from "@/db/types";

export const CRASH_RECOVERY_HEARTBEAT_WINDOW_MS = 60_000;
export const CRASH_RECOVERY_ORPHAN_RUN_ERROR = "crash_recovery: orphan run";

export interface RunningStepWarning {
  stepInstanceId: string;
  heartbeatAt: number;
  ageMs: number;
}

export interface CrashRecoveryReport {
  demotedQueuedStepIds: string[];
  staleRunningStepIds: string[];
  warnedRunningSteps: RunningStepWarning[];
  failedOrphanRunIds: string[];
}

export async function recoverFromCrash(db: Db): Promise<CrashRecoveryReport> {
  const report: CrashRecoveryReport = {
    demotedQueuedStepIds: [],
    staleRunningStepIds: [],
    warnedRunningSteps: [],
    failedOrphanRunIds: [],
  };

  const queued = await db.list(Collections.stepInstances, {
    status: StepStatus.Queued,
  });
  for (const step of queued) {
    await db.update(Collections.stepInstances, step.id, {
      status: StepStatus.Pending,
    });
    report.demotedQueuedStepIds.push(step.id);
  }

  const running = await db.list(Collections.stepInstances, {
    status: StepStatus.Running,
  });
  const now = Date.now();
  for (const step of running) {
    if (step.heartbeatAt === undefined) {
      report.staleRunningStepIds.push(step.id);
      continue;
    }
    const ageMs = now - step.heartbeatAt;
    if (ageMs < CRASH_RECOVERY_HEARTBEAT_WINDOW_MS) {
      report.warnedRunningSteps.push({
        stepInstanceId: step.id,
        heartbeatAt: step.heartbeatAt,
        ageMs,
      });
      console.warn(
        `[crash_recovery] running step still within heartbeat window: stepId=${step.id} heartbeatAt=${String(step.heartbeatAt)} ageMs=${String(ageMs)}`,
      );
      continue;
    }
    report.staleRunningStepIds.push(step.id);
  }

  const runningRuns = await db.list(Collections.workflowRuns, {
    status: RunStatus.Running,
  });
  for (const run of runningRuns) {
    if (run.currentStepId === undefined) continue;
    const currentStep = await db.get(
      Collections.stepInstances,
      run.currentStepId,
    );
    if (currentStep !== undefined) continue;
    await db.update(Collections.workflowRuns, run.id, {
      status: RunStatus.Failed,
      currentStepId: undefined,
      updatedAt: now,
      completedAt: run.completedAt ?? now,
      context: {
        ...run.context,
        crashRecoveryError: CRASH_RECOVERY_ORPHAN_RUN_ERROR,
      },
    });
    report.failedOrphanRunIds.push(run.id);
  }

  return report;
}
