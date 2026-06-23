// Self-observability subsystem (#109): a per-event audit stream plus a
// post-run self-analysis that files issues for recurring anomalies.
export {
  analyzeAllRuns,
  analyzeRuns,
  type AnalyzeResult,
  type IssueFiler,
} from "./analysis";
export {
  AnomalyKind,
  DEFAULT_THRESHOLDS,
  detectDurationOutlier,
  detectFixReviewLoop,
  detectHighRetryRate,
  detectMassBlocking,
  detectMergeFailure,
  detectTimeoutThenFastRetry,
  medianWallClockMs,
  type Anomaly,
  type AnomalyThresholds,
} from "./anomalies";
export {
  computeMergeMetrics,
  type MergeEfficiencyMetrics,
} from "./mergeMetrics";
export { listRunEvents, recordEvent, type RecordEventInput } from "./recorder";
