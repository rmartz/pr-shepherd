import type { StepInstance, WorkflowRun } from "@/db/schemas";
import type { DaemonStore } from "./daemonStore";

// ---------------------------------------------------------------------------
// Pure selectors over the daemon store (vision §7). Kept side-effect-free and
// taking only the state slice they read, so a component subscribes with
// `useDaemonStore((s) => selectRunSteps(s, runId))` and tests call them with a
// plain state object.
// ---------------------------------------------------------------------------

// One row of the run list: a run plus its indentation depth (0 = top-level).
export interface RunListRow {
  run: WorkflowRun;
  depth: number;
}

function byCreatedDesc(a: WorkflowRun, b: WorkflowRun): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// The run list as indented rows: each top-level run (no `parentRunId`),
// newest-first, immediately followed by its descendant runs at depth+1, so the
// view renders a nested tree as a flat, indented list. Child runs are grouped
// by `parentRunId` and ordered newest-first at every level.
export function selectRunListRows(
  state: Pick<DaemonStore, "runs">,
): RunListRow[] {
  const all = Object.values(state.runs);
  const childrenByParent = new Map<string, WorkflowRun[]>();
  for (const run of all) {
    if (run.parentRunId === undefined) continue;
    const siblings = childrenByParent.get(run.parentRunId) ?? [];
    siblings.push(run);
    childrenByParent.set(run.parentRunId, siblings);
  }

  const rows: RunListRow[] = [];
  const visit = (run: WorkflowRun, depth: number): void => {
    rows.push({ run, depth });
    for (const child of (childrenByParent.get(run.id) ?? []).sort(
      byCreatedDesc,
    )) {
      visit(child, depth + 1);
    }
  };
  for (const run of all
    .filter((run) => run.parentRunId === undefined)
    .sort(byCreatedDesc)) {
    visit(run, 0);
  }
  return rows;
}

// One run's steps in timeline order (execution order: `createdAt` ascending,
// id-tiebroken for determinism).
export function selectRunSteps(
  state: Pick<DaemonStore, "steps">,
  runId: string,
): StepInstance[] {
  return Object.values(state.steps)
    .filter((step) => step.runId === runId)
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

// A single step by id, or undefined when the store has not seen it.
export function selectStep(
  state: Pick<DaemonStore, "steps">,
  stepId: string,
): StepInstance | undefined {
  return state.steps[stepId];
}
