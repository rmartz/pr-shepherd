import { Collections } from "@/db/collections";
import {
  StepStatus,
  StepType,
  type StepInstance,
  type WorkflowRun,
} from "@/db/schemas";
import type { Db } from "@/db/types";
import {
  canAdmitStep,
  countsAgainstRepo,
  type ActiveCounts,
  type AdmissionDecision,
  type ConcurrencyConfig,
} from "./concurrency";

// ---------------------------------------------------------------------------
// Scheduler loop (vision §4.2).
//
// `runSchedulerTick` is a single-pass unit that:
//   1. Reads `pending` step instances and `running` step instances from Db.
//   2. Derives `ActiveCounts` from the running set — this is the source of
//      truth, not a long-lived in-process map. Doing the count fresh each
//      tick is what makes the scheduler restart-safe: a daemon crash
//      mid-tick leaves no stale counter state to recover. (Vision §4.2
//      acceptance criterion.)
//   3. Walks pending candidates in `createdAt` ASC order (FIFO) and asks
//      `canAdmitStep` (from #45) whether each one fits. Admitted steps
//      transition `pending → queued` via `Db.update`; rejected steps are
//      recorded in the report with their rejection reason.
//   4. Updates local counts after each admission so subsequent candidates
//      within the same tick see the saturating effect.
//
// `startScheduler` is the long-running wrapper that invokes `runSchedulerTick`
// on a configured cadence. It is intentionally thin so tests can supply
// their own `sleep` and observe each tick via hooks.
// ---------------------------------------------------------------------------

export interface SchedulerConfig {
  concurrency: ConcurrencyConfig;
}

export interface AdmittedStep {
  stepInstanceId: string;
}

export interface RejectedStep {
  stepInstanceId: string;
  decision: AdmissionDecision; // discriminated union — `admit: false` carries reason
}

export interface SchedulerTickReport {
  admitted: AdmittedStep[];
  rejected: RejectedStep[];
  pendingCount: number;
}

export async function runSchedulerTick(
  db: Db,
  config: SchedulerConfig,
): Promise<SchedulerTickReport> {
  const pending = await db.list(Collections.stepInstances, {
    status: StepStatus.Pending,
  });
  if (pending.length === 0) {
    return { admitted: [], rejected: [], pendingCount: 0 };
  }

  // Fetch running steps and workflow runs to derive ActiveCounts and to
  // resolve each step's owning repo. We only fetch runs referenced by
  // pending/running steps, but the simplest correct version is to read
  // all runs once and index by id — these collections are small relative
  // to step volume and the per-tick cost is bounded.
  const running = await db.list(Collections.stepInstances, {
    status: StepStatus.Running,
  });
  const runs = await db.list(Collections.workflowRuns);
  const runById = new Map<string, WorkflowRun>();
  for (const run of runs) {
    runById.set(run.id, run);
  }

  const counts = deriveActiveCounts(running, runById);

  // FIFO across iterations: sort by createdAt ASC. Ties broken by id so
  // the order is deterministic when timestamps collide.
  const ordered = [...pending].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const admitted: AdmittedStep[] = [];
  const rejected: RejectedStep[] = [];

  for (const step of ordered) {
    const run = runById.get(step.runId);
    if (run === undefined) {
      // A step whose parent run was deleted out from under it is an
      // inconsistency the scheduler cannot repair. Skip it; surfacing
      // requires a separate reconciliation pass.
      continue;
    }
    const decision = canAdmitStep(
      { stepType: step.stepType, repoId: run.repo },
      counts,
      config.concurrency,
    );
    if (decision.admit) {
      const now = Date.now();
      await db.update(Collections.stepInstances, step.id, {
        status: StepStatus.Queued,
        queuedAt: now,
      });
      admitted.push({ stepInstanceId: step.id });
      incrementCounts(counts, step.stepType, run.repo);
    } else {
      rejected.push({ stepInstanceId: step.id, decision });
    }
  }

  return { admitted, rejected, pendingCount: pending.length };
}

function deriveActiveCounts(
  running: StepInstance[],
  runById: Map<string, WorkflowRun>,
): ActiveCounts {
  const counts: ActiveCounts = {
    systemClaude: 0,
    systemGithubApi: 0,
    perRepo: new Map<string, number>(),
  };
  for (const step of running) {
    const run = runById.get(step.runId);
    if (run === undefined) continue;
    incrementCounts(counts, step.stepType, run.repo);
  }
  return counts;
}

function incrementCounts(
  counts: ActiveCounts,
  stepType: StepInstance["stepType"],
  repoId: string,
): void {
  if (!countsAgainstRepo(stepType)) return;
  counts.perRepo.set(repoId, (counts.perRepo.get(repoId) ?? 0) + 1);
  // Per-step-type global dimensions. WaitExternal/WaitAuthorPush count
  // only against the repo dimension (no global cap).
  switch (stepType) {
    case StepType.ClaudeSkill:
      counts.systemClaude += 1;
      break;
    case StepType.GithubApi:
      counts.systemGithubApi += 1;
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// startScheduler — long-running cadence wrapper around runSchedulerTick.
//
// `sleep` is injectable so tests can advance the loop without real timers.
// `onTick` fires after every tick (useful for tests to count iterations or
// to swap in a stub for the actual work). `onTickError` receives any error
// thrown during a tick so the loop can survive transient failures (e.g. a
// Db hiccup) without crashing the daemon.
// ---------------------------------------------------------------------------

export interface SchedulerHandle {
  stop: () => void;
}

export interface StartSchedulerOptions {
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  onTick?: (report: SchedulerTickReport | undefined) => void;
  onTickError?: (err: unknown) => void;
}

export function startScheduler(
  db: Db,
  config: SchedulerConfig,
  options: StartSchedulerOptions,
): SchedulerHandle {
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  let running = true;

  const loop = async (): Promise<void> => {
    while (running) {
      let report: SchedulerTickReport | undefined;
      try {
        report = await runSchedulerTick(db, config);
        options.onTick?.(report);
      } catch (err) {
        // A throw from `runSchedulerTick` (Db hiccup) or from the `onTick`
        // hook (test stub) must not crash the daemon. The loop survives
        // and the error is surfaced to the configured handler.
        options.onTickError?.(err);
      }
      // Note: `running` is mutated externally by `handle.stop()`, so the
      // next `while (running)` evaluation after sleep is what exits the
      // loop. We do not short-circuit before sleep — at the cost of one
      // extra interval delay on shutdown, this keeps the loop trivially
      // analyzable (no flow-control branch ESLint flags as unreachable).
      await sleep(options.intervalMs);
    }
  };

  void loop();

  return {
    stop: () => {
      running = false;
    },
  };
}
