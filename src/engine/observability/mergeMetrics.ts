import { EventType, type EventRecord, type WorkflowRun } from "@/db";

// Per-merge efficiency metrics (#109, criterion 3). Computed once a run
// reaches a terminal merge from the run's accumulated timing metrics plus
// its event stream. These quantify how much work it took to land one PR —
// the raw material for spotting inefficient lifecycles (many review
// cycles, high retry counts, long external waits) at a glance.
export interface MergeEfficiencyMetrics {
  runId: string;
  repo: string;
  prNumber: number;
  headSha?: string;
  // Wall-clock from run creation to merge completion.
  wallClockMs: number;
  // Time the daemon spent inside Claude subprocesses for this PR.
  claudeMs: number;
  // Time spent polling external systems (CI / Copilot).
  externalWaitMs: number;
  // Distinct review→fix cycles: a review followed by a fix is one cycle.
  reviewCycles: number;
  // Total step retries across the run's lifecycle.
  retries: number;
  // Whether the merge succeeded on its first attempt (no merge_failed
  // event preceded the merge_completed event).
  mergedFirstTry: boolean;
  // Total merge attempts it took to land: `merge_failed` events + 1 (the
  // successful attempt). This is the run-scoped efficiency count; the durable
  // per-(PR, head SHA) budget that actually gates retries lives on the PR as
  // marker comments (see the merge coordinator's `attemptLedger`, #252). Aligns
  // with the shared efficiency-schema `mergeAttempts` definition.
  mergeAttempts: number;
}

// Compute merge-efficiency metrics for one merged run. `events` is the
// run's full event stream (any order); `run` supplies the timing buckets
// and identity. The merge SHA is taken from the merge_completed event
// when present so the metric is tied to the exact commit that landed.
export function computeMergeMetrics(
  run: WorkflowRun,
  events: EventRecord[],
): MergeEfficiencyMetrics {
  const mergeCompleted = events.find(
    (e) => e.eventType === EventType.MergeCompleted,
  );
  const mergeFailures = events.filter(
    (e) => e.eventType === EventType.MergeFailed,
  ).length;
  const reviewCycles = events.filter(
    (e) =>
      e.eventType === EventType.StepCompleted &&
      e.decidingGate === "REVIEWED_BY_SKILL",
  ).length;
  const retries = events.filter(
    (e) => e.eventType === EventType.StepRetried,
  ).length;
  const completedAt =
    run.completedAt ?? mergeCompleted?.createdAt ?? run.createdAt;

  return {
    runId: run.id,
    repo: run.repo,
    prNumber: run.prNumber,
    headSha: mergeCompleted?.headSha,
    wallClockMs: Math.max(0, completedAt - run.createdAt),
    claudeMs: run.metrics.totalClaudeMs,
    externalWaitMs: run.metrics.totalExternalWaitMs,
    reviewCycles,
    retries,
    mergedFirstTry: mergeFailures === 0,
    mergeAttempts: mergeFailures + 1,
  };
}
