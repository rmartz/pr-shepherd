import { Collections } from "@/db/collections";
import {
  RunStatus,
  StepStatus,
  type StepInstance,
  type WorkflowRun,
} from "@/db/schemas";
import type { Db } from "@/db/types";

// ---------------------------------------------------------------------------
// Graceful-drain per-PR aggregation (#110, design §6).
//
// On interrupt the daemon drains in-flight work (graceful shutdown, #208) and
// must report what each PR ended up with — not just a global "N steps drained"
// count. This module rolls the persisted step set up into one summary per PR so
// the shutdown path can log a per-PR outcome ("PR 42: 3 completed, 1 still
// running at exit") and an operator sees exactly where each PR landed.
//
// Aggregation is a pure read-side rollup; it never mutates state, so it is safe
// to call repeatedly during a drain loop and once more at exit. It scopes the
// scan to *active* (non-terminal) runs and reads only their steps, so the cost
// is proportional to the in-flight fleet rather than to total historical
// volume — a long-finished run's steps are never enumerated (#231).
// ---------------------------------------------------------------------------

// Runs the drain report cares about: a terminal run (completed / failed /
// cancelled) is settled history, not something being drained. Mirrors the
// non-terminal set used by enrollment's active-run lookup.
const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  RunStatus.Pending,
  RunStatus.Running,
];

export interface PrDrainSummary {
  repo: string;
  prNumber: number;
  // Steps that reached a terminal-success state.
  completed: number;
  // Steps that reached a terminal-failure state.
  failed: number;
  // Steps still in flight (`running` or `waiting`) at the moment of the rollup.
  inFlight: number;
}

export interface DrainAggregate {
  // One entry per PR with at least one step, sorted by repo then prNumber for
  // a stable, log-friendly order.
  perPr: PrDrainSummary[];
  // Total steps still in flight across all PRs — the global drain gauge.
  totalInFlight: number;
}

function isInFlight(status: StepStatus): boolean {
  return status === StepStatus.Running || status === StepStatus.Waiting;
}

function bucketFor(
  summaries: Map<string, PrDrainSummary>,
  run: WorkflowRun,
): PrDrainSummary {
  const key = `${run.repo}#${String(run.prNumber)}`;
  const existing = summaries.get(key);
  if (existing !== undefined) return existing;
  const created: PrDrainSummary = {
    repo: run.repo,
    prNumber: run.prNumber,
    completed: 0,
    failed: 0,
    inFlight: 0,
  };
  summaries.set(key, created);
  return created;
}

function tally(summary: PrDrainSummary, step: StepInstance): void {
  if (step.status === StepStatus.Completed) summary.completed += 1;
  else if (step.status === StepStatus.Failed) summary.failed += 1;
  else if (isInFlight(step.status)) summary.inFlight += 1;
}

// Roll the active-run step set up into a per-PR drain summary. We start from
// the non-terminal runs and read only their steps, so a dangling step (one
// whose run is missing or terminal) is simply never visited — that
// inconsistency belongs to a separate reconciliation pass, not the drain
// report. Each active run's steps are fetched concurrently.
export async function aggregateDrainResults(db: Db): Promise<DrainAggregate> {
  const runGroups = await Promise.all(
    ACTIVE_RUN_STATUSES.map((status) =>
      db.list(Collections.workflowRuns, { status }),
    ),
  );
  const activeRuns = runGroups.flat();

  const withSteps = await Promise.all(
    activeRuns.map(async (run) => ({
      run,
      steps: await db.list(Collections.stepInstances, { runId: run.id }),
    })),
  );

  const summaries = new Map<string, PrDrainSummary>();
  for (const { run, steps } of withSteps) {
    const summary = bucketFor(summaries, run);
    for (const step of steps) tally(summary, step);
  }

  const perPr = [...summaries.values()].sort((a, b) =>
    a.repo !== b.repo ? (a.repo < b.repo ? -1 : 1) : a.prNumber - b.prNumber,
  );
  const totalInFlight = perPr.reduce((sum, s) => sum + s.inFlight, 0);
  return { perPr, totalInFlight };
}
