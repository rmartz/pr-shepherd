"use client";

import { useCallback, useMemo } from "react";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { RunListView } from "@/components/runs/RunListView";
import { useAuthedSubscription } from "@/hooks";
import { subscribeToRuns } from "@/lib/firebase/subscriptions";
import { selectRunListRows, useDaemonStore } from "@/store";

export default function Home() {
  const setRuns = useDaemonStore((state) => state.setRuns);
  // Select the stable `runs` slice and derive the ordered rows with `useMemo`
  // rather than passing `selectRunListRows` straight to the store — the selector
  // builds a fresh array each call, which would churn on every render.
  const runs = useDaemonStore((state) => state.runs);
  const rows = useMemo(() => selectRunListRows({ runs }), [runs]);

  // Stream runs into the store while signed in; detach on sign-out/unmount.
  const subscribe = useCallback(() => subscribeToRuns(setRuns), [setRuns]);
  useAuthedSubscription(subscribe);

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">PR Shepherd</h1>
        <SignOutButton />
      </header>
      <RunListView rows={rows} />
    </div>
  );
}
