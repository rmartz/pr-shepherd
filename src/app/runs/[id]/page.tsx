"use client";

import { useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import { RunDetailView } from "@/components/runs/RunDetailView";
import { useAuthedSubscription } from "@/hooks";
import { subscribeToSteps } from "@/lib/firebase/subscriptions";
import { selectRunSteps, useDaemonStore } from "@/store";

export default function RunDetailPage() {
  const { id: runId } = useParams<{ id: string }>();

  const setStepsForRun = useDaemonStore((state) => state.setStepsForRun);
  // Select the stable `steps` slice and derive the ordered timeline with
  // `useMemo` — `selectRunSteps` builds a fresh array each call.
  const steps = useDaemonStore((state) => state.steps);
  const timeline = useMemo(
    () => selectRunSteps({ steps }, runId),
    [steps, runId],
  );
  // Show the run's PR title if it is already in the store (e.g. navigated from
  // the run list), otherwise fall back to the id.
  const run = useDaemonStore((state) => state.runs[runId]);

  // Stream this run's steps into the store while signed in.
  const subscribe = useCallback(
    () =>
      subscribeToSteps(runId, (next) => {
        setStepsForRun(runId, next);
      }),
    [runId, setStepsForRun],
  );
  useAuthedSubscription(subscribe);

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {run?.prTitle ?? `Run ${runId}`}
        </h1>
      </header>
      <RunDetailView steps={timeline} />
    </div>
  );
}
