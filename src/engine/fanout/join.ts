import type { WorkflowGraph } from "@/config";
import { Collections } from "@/db/collections";
import { StepStatus, type StepInstance } from "@/db/schemas";
import type { Db } from "@/db/types";
import { advanceCompletedStep, type AdvanceResult } from "@/engine/advance";
import { computeStepMetrics, runMetricIncrements } from "@/engine/metrics";

// ---------------------------------------------------------------------------
// Fan-in: join a fan-out parent once its children finish (#280).
//
// `runJoinTick` is the gather half of the step-level fan-out/fan-in primitive
// and the counterpart to `spawnChildSteps`. Each scheduler tick it looks for
// `waiting` steps that have children (steps carrying `parentStepId === parent.id`)
// and, for every such parent whose children have *all* reached a terminal
// state, transitions the parent off `waiting`:
//   - aggregates the children's outputs onto the parent as
//     `{ children: [{ index, status, output }, ...] }`, ordered by spawn order,
//   - completes the parent (or fails it if any child failed), merging the
//     aggregate into the run context exactly as a normal completion would, and
//   - advances the run from the now-completed parent so routing proceeds.
//
// Restart-safe by construction: the join holds no in-memory state. It re-derives
// "are all children done?" from persisted child-step status on every tick, so a
// daemon that crashes mid-join simply re-evaluates and completes the parent on a
// later tick. A `waiting` step with *no* children is an external `wait_*` step,
// not a fan-out parent, and is left untouched.
// ---------------------------------------------------------------------------

const TERMINAL_CHILD_STATUSES: ReadonlySet<StepStatus> = new Set([
  StepStatus.Cancelled,
  StepStatus.Completed,
  StepStatus.Failed,
  StepStatus.Skipped,
]);

export interface JoinDeps {
  db: Db;
  // Resolve a run's workflow graph — forwarded to `advanceCompletedStep` so a
  // completed parent routes onward. Injected exactly as the advance/execution
  // units take it.
  getGraph: (workflowId: string) => WorkflowGraph | undefined;
  maxRetries?: number;
  newId?: () => string;
  now?: () => number;
}

export interface JoinOutcome {
  parentStepId: string;
  // The parent's terminal status after the join.
  status: StepStatus.Completed | StepStatus.Failed;
  // The advance result, present only when the parent completed (a failed parent
  // does not route onward — mirroring the runner's `failStep`).
  advance?: AdvanceResult;
}

export interface JoinTickReport {
  joined: JoinOutcome[];
}

// One child's contribution to the aggregated parent output.
interface AggregatedChild {
  index: number;
  status: StepStatus;
  output: Record<string, unknown>;
}

// Resume every fan-out parent whose *required* children are all terminal.
export async function runJoinTick(deps: JoinDeps): Promise<JoinTickReport> {
  const nowMs = (deps.now ?? Date.now)();
  const waiting = await deps.db.list(Collections.stepInstances, {
    status: StepStatus.Waiting,
  });

  const joined: JoinOutcome[] = [];
  for (const parent of waiting) {
    const rawChildren = await deps.db.list(Collections.stepInstances, {
      parentStepId: parent.id,
    });
    // No children → an external `wait_*` step, not a fan-out parent. Leave it.
    if (rawChildren.length === 0) {
      continue;
    }
    // Force-terminate any child past its deadline as `skipped` (#313) before
    // deciding whether the parent can join — this is what bounds a required
    // child's wait.
    const children = await enforceDeadlines(rawChildren, nowMs, deps.db);
    // Optional children (#313) never gate the join; wait only on required ones.
    const stillWaiting = children.some(
      (c) => c.optional !== true && !TERMINAL_CHILD_STATUSES.has(c.status),
    );
    if (stillWaiting) {
      continue;
    }
    joined.push(await joinParent(parent, children, deps));
  }
  return { joined };
}

// Mark any non-terminal child whose deadline has passed as `skipped`, returning
// the children with those statuses updated so the caller sees the effect this
// tick. Restart-safe: derived from the persisted `deadlineAt`, so a crash simply
// re-evaluates the same bound on a later tick.
async function enforceDeadlines(
  children: StepInstance[],
  nowMs: number,
  db: Db,
): Promise<StepInstance[]> {
  const result: StepInstance[] = [];
  for (const child of children) {
    if (
      child.deadlineAt !== undefined &&
      child.deadlineAt <= nowMs &&
      !TERMINAL_CHILD_STATUSES.has(child.status)
    ) {
      const stepDelta = computeStepMetrics({ ...child, completedAt: nowMs });
      const nextMetrics: StepInstance["metrics"] = {
        claudeMs: child.metrics.claudeMs + stepDelta.claudeMs,
        activeMs: child.metrics.activeMs + stepDelta.activeMs,
        scheduleWaitMs: child.metrics.scheduleWaitMs + stepDelta.scheduleWaitMs,
        externalWaitMs: child.metrics.externalWaitMs + stepDelta.externalWaitMs,
      };
      await db.update(Collections.stepInstances, child.id, {
        status: StepStatus.Skipped,
        completedAt: nowMs,
        metrics: nextMetrics,
      });
      const run = await db.get(Collections.workflowRuns, child.runId);
      if (run !== undefined) {
        await db.increment(
          Collections.workflowRuns,
          child.runId,
          runMetricIncrements(stepDelta),
          { updatedAt: nowMs },
        );
      }
      result.push({
        ...child,
        status: StepStatus.Skipped,
        completedAt: nowMs,
        metrics: nextMetrics,
      });
    } else {
      result.push(child);
    }
  }
  return result;
}

async function joinParent(
  parent: StepInstance,
  children: StepInstance[],
  deps: JoinDeps,
): Promise<JoinOutcome> {
  const now = deps.now ?? Date.now;

  // Order by spawn sequence (`createdAt`, tie-broken by id) so `index` is
  // stable and matches the order children were spawned in.
  const ordered = [...children].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const aggregatedChildren: AggregatedChild[] = ordered.map((child, index) => ({
    index,
    status: child.status,
    output: child.output,
  }));
  const output = { children: aggregatedChildren };

  // A failed *required* child fails the parent (halting the run for a human);
  // an optional child's failure is ignored (#313). Otherwise the parent
  // completes.
  const anyFailed = ordered.some(
    (c) => c.optional !== true && c.status === StepStatus.Failed,
  );
  const status = anyFailed ? StepStatus.Failed : StepStatus.Completed;

  const completedAt = now();
  const stepDelta = computeStepMetrics({ ...parent, completedAt });
  const nextMetrics: StepInstance["metrics"] = {
    claudeMs: parent.metrics.claudeMs + stepDelta.claudeMs,
    activeMs: parent.metrics.activeMs + stepDelta.activeMs,
    scheduleWaitMs: parent.metrics.scheduleWaitMs + stepDelta.scheduleWaitMs,
    externalWaitMs: parent.metrics.externalWaitMs + stepDelta.externalWaitMs,
  };
  await deps.db.update(Collections.stepInstances, parent.id, {
    status,
    output,
    ...(anyFailed ? { error: "One or more child steps failed" } : {}),
    completedAt,
    metrics: nextMetrics,
  });

  // Roll the parent's own delta into the run total and — for a successful
  // completion — merge the aggregate into the run context, mirroring the
  // runner's terminal writes. A failed parent skips the context merge (matching
  // the runner's `failStep`, which only rolls metrics). The children's deltas
  // were already rolled in as each child completed, so this adds only the
  // parent's own (fan-out wait) time, never double-counting the children.
  const run = await deps.db.get(Collections.workflowRuns, parent.runId);
  if (run !== undefined) {
    if (!anyFailed) {
      await deps.db.update(Collections.workflowRuns, parent.runId, {
        context: { ...run.context, ...output },
      });
    }
    await deps.db.increment(
      Collections.workflowRuns,
      parent.runId,
      runMetricIncrements(stepDelta),
      { updatedAt: completedAt },
    );
  }

  if (status === StepStatus.Failed) {
    return { parentStepId: parent.id, status };
  }

  // Re-read so `advanceCompletedStep` sees the persisted `completed` status and
  // aggregated output, then route the run onward from the parent.
  const completed = await deps.db.get(Collections.stepInstances, parent.id);
  const advance =
    completed === undefined
      ? undefined
      : await advanceCompletedStep(completed, {
          db: deps.db,
          getGraph: deps.getGraph,
          maxRetries: deps.maxRetries,
          newId: deps.newId,
          now: deps.now,
        });
  return { parentStepId: parent.id, status, advance };
}
