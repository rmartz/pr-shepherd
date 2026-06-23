import { EventType, type EventRecord, type WorkflowRun } from "@/db";
import {
  AnomalyKind,
  DEFAULT_THRESHOLDS,
  type Anomaly,
  type AnomalyThresholds,
} from "./types";

// Per-run anomaly detectors (#109, criterion 2). Each is a pure function
// over one run's events (and the run document where timing is needed),
// returning zero or more findings. They never touch GitHub or the clock —
// the orchestrator owns I/O. Cross-run detection (mass blocking) lives in
// `crossRun.ts`.

// timeout-then-fast-retry: a step that failed with a timeout outcome and
// whose immediately-following retry completed faster than `fastRetryMs`.
// A genuinely-hung step does not finish in seconds on retry, so a fast
// success implies the timeout fired prematurely.
export function detectTimeoutThenFastRetry(
  events: EventRecord[],
  thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
): Anomaly[] {
  const sorted = [...events].sort((a, b) => a.createdAt - b.createdAt);
  const anomalies: Anomaly[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const failure = sorted[i];
    if (
      failure?.eventType !== EventType.StepFailed ||
      failure.outcome !== "timeout"
    ) {
      continue;
    }
    const retry = sorted
      .slice(i + 1)
      .find(
        (e) =>
          e.stepInstanceId === failure.stepInstanceId &&
          e.eventType === EventType.StepCompleted,
      );
    if (retry === undefined) continue;
    const retryMs = retry.createdAt - failure.createdAt;
    if (retryMs <= thresholds.fastRetryMs) {
      anomalies.push({
        kind: AnomalyKind.TimeoutThenFastRetry,
        dedupeKey: `${AnomalyKind.TimeoutThenFastRetry}:${failure.runId}:${failure.stepInstanceId ?? "unknown"}`,
        title: `Timeout then fast retry on PR ${failure.repo}#${String(failure.prNumber)}`,
        body: `Step ${failure.stepInstanceId ?? "unknown"} timed out but its retry completed in ${String(retryMs)}ms (< ${String(thresholds.fastRetryMs)}ms). The timeout likely fired before the step was actually stuck.`,
      });
    }
  }
  return anomalies;
}

// fix-review loops: a run that cycled review→fix at or above
// `fixReviewLoopCycles` times without converging on a merge.
export function detectFixReviewLoop(
  events: EventRecord[],
  thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
): Anomaly[] {
  const reviewCycles = events.filter(
    (e) =>
      e.eventType === EventType.StepCompleted &&
      e.decidingGate === "REVIEWED_BY_SKILL",
  );
  if (reviewCycles.length < thresholds.fixReviewLoopCycles) return [];
  const first = reviewCycles[0];
  if (first === undefined) return [];
  return [
    {
      kind: AnomalyKind.FixReviewLoop,
      dedupeKey: `${AnomalyKind.FixReviewLoop}:${first.runId}`,
      title: `Fix-review loop on PR ${first.repo}#${String(first.prNumber)}`,
      body: `Run ${first.runId} went through ${String(reviewCycles.length)} review cycles (>= ${String(thresholds.fixReviewLoopCycles)}) without converging. The fix→review loop may not be making progress.`,
    },
  ];
}

// high retry rate: total step retries relative to total steps started, at
// or above `highRetryRatio`. A run that retries half its steps is unstable.
export function detectHighRetryRate(
  events: EventRecord[],
  thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
): Anomaly[] {
  const retries = events.filter(
    (e) => e.eventType === EventType.StepRetried,
  ).length;
  const stepsStarted = events.filter(
    (e) => e.eventType === EventType.StepStarted,
  ).length;
  if (stepsStarted === 0) return [];
  const ratio = retries / stepsStarted;
  if (ratio < thresholds.highRetryRatio) return [];
  const sample = events[0];
  if (sample === undefined) return [];
  return [
    {
      kind: AnomalyKind.HighRetryRate,
      dedupeKey: `${AnomalyKind.HighRetryRate}:${sample.runId}`,
      title: `High retry rate on PR ${sample.repo}#${String(sample.prNumber)}`,
      body: `Run ${sample.runId} retried ${String(retries)} of ${String(stepsStarted)} steps (ratio ${ratio.toFixed(2)} >= ${String(thresholds.highRetryRatio)}).`,
    },
  ];
}

// merge failures: any merge_failed event on the run.
export function detectMergeFailure(events: EventRecord[]): Anomaly[] {
  return events
    .filter((e) => e.eventType === EventType.MergeFailed)
    .map((failure) => ({
      kind: AnomalyKind.MergeFailure,
      dedupeKey: `${AnomalyKind.MergeFailure}:${failure.runId}:${failure.headSha ?? "unknown"}`,
      title: `Merge failed on PR ${failure.repo}#${String(failure.prNumber)}`,
      body: `Run ${failure.runId} failed to merge at ${failure.headSha ?? "an unknown SHA"}${failure.outcome ? `: ${failure.outcome}` : ""}.`,
    }));
}

// duration outlier: a run whose wall-clock is at or above
// `durationOutlierMultiple` times the cohort median. `cohortMedianMs` is
// supplied by the orchestrator from the runs it is analyzing together.
export function detectDurationOutlier(
  run: WorkflowRun,
  cohortMedianMs: number,
  thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
): Anomaly[] {
  if (run.completedAt === undefined || cohortMedianMs <= 0) return [];
  const wallClockMs = run.completedAt - run.createdAt;
  if (wallClockMs < cohortMedianMs * thresholds.durationOutlierMultiple) {
    return [];
  }
  return [
    {
      kind: AnomalyKind.DurationOutlier,
      dedupeKey: `${AnomalyKind.DurationOutlier}:${run.id}`,
      title: `Duration outlier on PR ${run.repo}#${String(run.prNumber)}`,
      body: `Run ${run.id} took ${String(wallClockMs)}ms — at least ${String(thresholds.durationOutlierMultiple)}x the cohort median of ${String(cohortMedianMs)}ms.`,
    },
  ];
}
