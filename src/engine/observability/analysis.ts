import { Collections, type Db, type WorkflowRun } from "@/db";
import { listRunEvents } from "./recorder";
import {
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

// Post-run self-analysis orchestrator (#109, criterion 2). It reads the
// run cohort and their event streams, runs every detector, dedupes the
// findings, and files one issue per distinct anomaly through an injected
// `IssueFiler`. The filer is a seam so tests assert what *would* be filed
// without spawning `gh` or hitting GitHub.

// Files one anomaly as a GitHub issue (or any sink). `dedupeKey` lets a
// production implementation skip re-filing an already-open issue.
export interface IssueFiler {
  file(anomaly: Anomaly): Promise<void>;
}

export interface AnalyzeResult {
  // Distinct anomalies detected, after dedupe.
  anomalies: Anomaly[];
  // The subset that was filed this run (excludes ones the filer skipped).
  filed: Anomaly[];
}

// Run the full anomaly sweep over a cohort of runs. `runs` is the set of
// runs to analyze together (the cohort the duration-outlier baseline is
// computed from); per-run event streams are loaded lazily from `db`.
export async function analyzeRuns(
  db: Db,
  runs: WorkflowRun[],
  filer: IssueFiler,
  thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
): Promise<AnalyzeResult> {
  const cohortMedianMs = medianWallClockMs(runs);
  const found: Anomaly[] = [];

  for (const run of runs) {
    const events = await listRunEvents(db, run.id);
    found.push(
      ...detectTimeoutThenFastRetry(events, thresholds),
      ...detectFixReviewLoop(events, thresholds),
      ...detectHighRetryRate(events, thresholds),
      ...detectMergeFailure(events),
      ...detectDurationOutlier(run, cohortMedianMs, thresholds),
    );
  }
  found.push(...detectMassBlocking(runs, thresholds));

  const anomalies = dedupe(found);
  const filed: Anomaly[] = [];
  for (const anomaly of anomalies) {
    await filer.file(anomaly);
    filed.push(anomaly);
  }
  return { anomalies, filed };
}

// Convenience wrapper that analyzes every run currently in the store.
export async function analyzeAllRuns(
  db: Db,
  filer: IssueFiler,
  thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
): Promise<AnalyzeResult> {
  const runs = await db.list(Collections.workflowRuns);
  return analyzeRuns(db, runs, filer, thresholds);
}

// Collapse anomalies sharing a `dedupeKey` to the first occurrence so the
// same underlying problem is filed once, not once per detector pass.
function dedupe(anomalies: Anomaly[]): Anomaly[] {
  const seen = new Set<string>();
  const unique: Anomaly[] = [];
  for (const anomaly of anomalies) {
    if (seen.has(anomaly.dedupeKey)) continue;
    seen.add(anomaly.dedupeKey);
    unique.push(anomaly);
  }
  return unique;
}
