// Anomaly taxonomy for post-run self-analysis (#109, criterion 2).
// Each detector emits zero or more `Anomaly` findings; the analysis
// orchestrator dedupes and files them as GitHub issues. Alphabetical.
export enum AnomalyKind {
  DurationOutlier = "duration_outlier",
  FixReviewLoop = "fix_review_loop",
  HighRetryRate = "high_retry_rate",
  MassBlocking = "mass_blocking",
  MergeFailure = "merge_failure",
  TimeoutThenFastRetry = "timeout_then_fast_retry",
}

// One detected anomaly. `title` and `body` are the GitHub issue payload;
// `dedupeKey` lets the orchestrator collapse repeat detections of the
// same underlying problem into a single filed issue.
export interface Anomaly {
  kind: AnomalyKind;
  dedupeKey: string;
  title: string;
  body: string;
}

// Tunable thresholds for the detectors. Defaults live in
// `DEFAULT_THRESHOLDS`; callers (and tests) may override any subset.
export interface AnomalyThresholds {
  // A retried step that completes within this many ms after a timeout
  // failure is "suspiciously fast" — the timeout likely fired early.
  fastRetryMs: number;
  // Review→fix cycles at or above this count flag a non-converging loop.
  fixReviewLoopCycles: number;
  // Retries / total steps at or above this ratio flag a high retry rate.
  highRetryRatio: number;
  // Wall-clock at or above this multiple of the cohort median is an outlier.
  durationOutlierMultiple: number;
  // Number of simultaneously-blocked runs at or above this count flags
  // mass blocking.
  massBlockingRuns: number;
}

export const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  durationOutlierMultiple: 3,
  fastRetryMs: 5_000,
  fixReviewLoopCycles: 4,
  highRetryRatio: 0.5,
  massBlockingRuns: 3,
};
