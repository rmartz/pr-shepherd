import { create } from "zustand";
import type { StepInstance, WorkflowRun } from "@/db/schemas";

// ---------------------------------------------------------------------------
// Daemon store (vision §7): the single client-side source of truth for daemon
// state. The Firestore `onSnapshot` subscriptions (#304) write into it; the run
// views read from it through the selectors in `selectors.ts`.
//
// The store deliberately imports **no Firestore** — the subscription layer
// feeds it — so it stays a pure, unit-testable reducer and Storybook can drive
// it with fixtures (per the "stories never depend on Firestore" convention).
//
// Two granularities of write:
//   - `setRuns` / `setStepsForRun` replace a whole snapshot window (what the
//     subscription callbacks, which deliver the full decoded query result each
//     tick, call — so a doc that left the query is dropped, not stranded).
//   - `upsertRun` / `removeRun` / `upsertStep` / `removeStep` are the
//     fine-grained mutations for incremental (doc-change) updates.
// ---------------------------------------------------------------------------

export interface DaemonStore {
  // Runs keyed by id; parent/child linkage lives on each run's `parentRunId` /
  // `childRunIds`.
  runs: Record<string, WorkflowRun>;
  // Every step keyed by id; grouped by `runId` at read time by the selectors.
  steps: Record<string, StepInstance>;
  // Replace the runs window with a full snapshot.
  setRuns: (runs: WorkflowRun[]) => void;
  // Replace one run's steps with a full snapshot (drops that run's steps absent
  // from `steps`, leaves other runs' steps untouched).
  setStepsForRun: (runId: string, steps: StepInstance[]) => void;
  upsertRun: (run: WorkflowRun) => void;
  removeRun: (runId: string) => void;
  upsertStep: (step: StepInstance) => void;
  removeStep: (stepId: string) => void;
}

function keyById<T extends { id: string }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([recordKey]) => recordKey !== key),
  );
}

export const useDaemonStore = create<DaemonStore>()((set) => ({
  runs: {},
  steps: {},
  setRuns: (runs) => {
    set({ runs: keyById(runs) });
  },
  setStepsForRun: (runId, steps) => {
    set((state) => ({
      steps: {
        ...Object.fromEntries(
          Object.entries(state.steps).filter(
            ([, step]) => step.runId !== runId,
          ),
        ),
        ...keyById(steps),
      },
    }));
  },
  upsertRun: (run) => {
    set((state) => ({ runs: { ...state.runs, [run.id]: run } }));
  },
  removeRun: (runId) => {
    set((state) => ({ runs: omitKey(state.runs, runId) }));
  },
  upsertStep: (step) => {
    set((state) => ({ steps: { ...state.steps, [step.id]: step } }));
  },
  removeStep: (stepId) => {
    set((state) => ({ steps: omitKey(state.steps, stepId) }));
  },
}));
