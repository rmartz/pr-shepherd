import { StepType, type StepInstance, type WorkflowRun } from "@/db/schemas";
import type { FieldIncrements } from "@/db/types";

export type StepMetricsDelta = StepInstance["metrics"];
export type RunMetrics = WorkflowRun["metrics"];

export function applyStepDelta(
  runMetrics: RunMetrics,
  stepDelta: StepMetricsDelta,
): RunMetrics {
  return {
    totalClaudeMs: runMetrics.totalClaudeMs + stepDelta.claudeMs,
    totalActiveMs: runMetrics.totalActiveMs + stepDelta.activeMs,
    totalScheduleWaitMs:
      runMetrics.totalScheduleWaitMs + stepDelta.scheduleWaitMs,
    totalExternalWaitMs:
      runMetrics.totalExternalWaitMs + stepDelta.externalWaitMs,
  };
}

// Map a step's terminal delta to the dotted `metrics.*` field-increment paths
// the run-level rollup applies via the atomic `Db.increment` primitive (#79).
// Using `increment` instead of read-modify-write `update` is what keeps
// concurrent step completions on the same run from dropping a delta.
export function runMetricIncrements(
  stepDelta: StepMetricsDelta,
): FieldIncrements {
  return {
    "metrics.totalActiveMs": stepDelta.activeMs,
    "metrics.totalClaudeMs": stepDelta.claudeMs,
    "metrics.totalExternalWaitMs": stepDelta.externalWaitMs,
    "metrics.totalScheduleWaitMs": stepDelta.scheduleWaitMs,
  };
}

export function computeStepMetrics(
  step: Pick<
    StepInstance,
    | "stepType"
    | "createdAt"
    | "queuedAt"
    | "startedAt"
    | "waitingAt"
    | "completedAt"
  >,
): StepMetricsDelta {
  const scheduleWaitMs = elapsed(step.createdAt, step.queuedAt);
  const claudeMs =
    step.stepType === StepType.ClaudeSkill
      ? elapsed(step.startedAt, step.completedAt)
      : 0;
  const activeMs =
    step.stepType === StepType.ClaudeSkill
      ? 0
      : elapsed(step.startedAt, step.waitingAt ?? step.completedAt);
  const externalWaitMs = elapsed(step.waitingAt, step.completedAt);

  return { claudeMs, activeMs, scheduleWaitMs, externalWaitMs };
}

function elapsed(start: number | undefined, end: number | undefined): number {
  if (start === undefined || end === undefined) {
    return 0;
  }
  return Math.max(0, end - start);
}
