import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type FirestoreError,
  type Unsubscribe,
} from "firebase/firestore";
import { Collections } from "@/db/collections";
import type { StepInstance, WorkflowRun } from "@/db/schemas";
import { getClientFirestore } from "./client";

// ---------------------------------------------------------------------------
// Firestore client subscriptions (vision §15). The daemon does not serve HTTP;
// the UI reads live state by subscribing to Firestore directly with the client
// SDK's `onSnapshot`. There is no SSE/polling bridge — Firestore pushes.
//
// Each subscription decodes raw snapshot documents through the shared Zod
// schema (`Collections.*.schema`) so callers receive the same `WorkflowRun` /
// `StepInstance` types the daemon writes, and returns the SDK's `Unsubscribe`
// so the caller owns teardown. Binding a subscription to the authenticated
// session (attach on sign-in, detach on sign-out/unmount) is
// `useAuthedSubscription`'s job; these functions are the pure transport.
// ---------------------------------------------------------------------------

// The UI shows recent/active runs, not the full history, so the runs
// subscription is capped and newest-first. Callers can widen the window.
const DEFAULT_RUNS_LIMIT = 100;

// Subscribe to the most recent workflow runs, newest first. `onData` fires on
// every snapshot with the decoded runs; `onError` receives Firestore transport
// errors (e.g. permission-denied on sign-out) and schema decode errors.
export function subscribeToRuns(
  onData: (runs: WorkflowRun[]) => void,
  onError?: (error: unknown) => void,
  runsLimit: number = DEFAULT_RUNS_LIMIT,
): Unsubscribe {
  const runsQuery = query(
    collection(getClientFirestore(), Collections.workflowRuns.name),
    orderBy("createdAt", "desc"),
    limit(runsLimit),
  );
  return onSnapshot(
    runsQuery,
    (snapshot) => {
      let decoded: WorkflowRun[];
      try {
        decoded = snapshot.docs.map((doc) =>
          Collections.workflowRuns.schema.parse(doc.data()),
        );
      } catch (err) {
        onError?.(err);
        return;
      }
      onData(decoded);
    },
    onError
      ? (e: FirestoreError) => {
          onError(e);
        }
      : undefined,
  );
}

// Subscribe to every step instance of one run. `onData` fires on every snapshot
// with the decoded steps; `onError` receives Firestore transport errors and
// schema decode errors.
export function subscribeToSteps(
  runId: string,
  onData: (steps: StepInstance[]) => void,
  onError?: (error: unknown) => void,
): Unsubscribe {
  const stepsQuery = query(
    collection(getClientFirestore(), Collections.stepInstances.name),
    where("runId", "==", runId),
  );
  return onSnapshot(
    stepsQuery,
    (snapshot) => {
      let decoded: StepInstance[];
      try {
        decoded = snapshot.docs.map((doc) =>
          Collections.stepInstances.schema.parse(doc.data()),
        );
      } catch (err) {
        onError?.(err);
        return;
      }
      onData(decoded);
    },
    onError
      ? (e: FirestoreError) => {
          onError(e);
        }
      : undefined,
  );
}
