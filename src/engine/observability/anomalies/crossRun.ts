import type { WorkflowRun } from "@/db";
import {
  AnomalyKind,
  DEFAULT_THRESHOLDS,
  type Anomaly,
  type AnomalyThresholds,
} from "./types";

// Cross-run anomaly detection (#109, criterion 2). Unlike the per-run
// detectors, mass blocking is a property of the whole run cohort, so it
// takes the full run list rather than a single run's events.

// mass blocking: at or above `massBlockingRuns` runs are simultaneously
// paused (operator hold) — a sign that something systemic (a red main, an
// exhausted CI budget) has stalled the whole queue rather than one PR.
export function detectMassBlocking(
  runs: WorkflowRun[],
  thresholds: AnomalyThresholds = DEFAULT_THRESHOLDS,
): Anomaly[] {
  const blocked = runs.filter((r) => r.paused === true);
  if (blocked.length < thresholds.massBlockingRuns) return [];
  const repos = [...new Set(blocked.map((r) => r.repo))].sort();
  return [
    {
      kind: AnomalyKind.MassBlocking,
      dedupeKey: `${AnomalyKind.MassBlocking}:${blocked
        .map((r) => r.id)
        .sort()
        .join(",")}`,
      title: `Mass blocking: ${String(blocked.length)} runs paused`,
      body: `${String(blocked.length)} runs (>= ${String(thresholds.massBlockingRuns)}) are paused across ${String(repos.length)} repo(s): ${repos.join(", ")}. A systemic stall (red main, exhausted CI budget) is likely.`,
    },
  ];
}

// Median wall-clock of completed runs, used by the duration-outlier
// detector as the cohort baseline. Returns 0 when no run has completed,
// which the detector treats as "no baseline — skip".
export function medianWallClockMs(runs: WorkflowRun[]): number {
  const durations = runs
    .flatMap((r) =>
      r.completedAt === undefined ? [] : [r.completedAt - r.createdAt],
    )
    .sort((a, b) => a - b);
  if (durations.length === 0) return 0;
  const mid = Math.floor(durations.length / 2);
  const high = durations[mid] ?? 0;
  if (durations.length % 2 === 1) return high;
  return ((durations[mid - 1] ?? 0) + high) / 2;
}
