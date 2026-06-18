import type { CheckSuiteSnapshot, PrSnapshot } from "./types";
import { CIState } from "./state-vector";

// ---------------------------------------------------------------------------
// CI axis derivation (#96).
//
// The hard-won rule: RUNNING/FAILING are GitHub-Actions-only. A pending
// non-Actions commit status (Vercel) must NOT make CI look "not done", and a
// passing rollup or a rate-limited Vercel must NEVER mask a real Actions
// failure. Infra cancels (CANCELLED / TIMED_OUT / STARTUP_FAILURE) are a
// separate bucket from real failures, and >=2 of them on the same commit is
// the retried-by-infra signal.
// ---------------------------------------------------------------------------

const ACTIONS_APP = "github actions";

// Conclusions that mean "infra ate the run", distinct from a genuine red test.
const INFRA_CANCEL_CONCLUSIONS = new Set([
  "CANCELLED",
  "STALE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);

// Conclusions that mean a genuine failure the author must fix.
const FAILURE_CONCLUSIONS = new Set(["ACTION_REQUIRED_FAILURE", "FAILURE"]);

function isActionsSuite(suite: CheckSuiteSnapshot): boolean {
  return (suite.appName ?? "").toLowerCase() === ACTIONS_APP;
}

export function deriveCi(snapshot: PrSnapshot): CIState {
  const actions = snapshot.checkSuites.filter(isActionsSuite);

  // No Actions suites at all → nothing is gating on CI; treat as passed so a
  // lone pending Vercel status never blocks downstream.
  if (actions.length === 0) return CIState.Passed;

  const failures = actions.filter(
    (s) => s.conclusion !== undefined && FAILURE_CONCLUSIONS.has(s.conclusion),
  );
  // A real failure always wins — over a green rollup, a pending Vercel, or a
  // concurrent infra cancel.
  if (failures.length > 0) return CIState.Failing;

  // ACTION_REQUIRED on a not-yet-failed suite means the run is waiting for a
  // maintainer to authorize it (first-time / fork contributor).
  const needsAuth = actions.some(
    (s) => s.conclusion === "ACTION_REQUIRED" || s.status === "WAITING",
  );
  if (needsAuth) return CIState.NeedsAuth;

  const running = actions.some(
    (s) => s.status !== "COMPLETED" && s.status !== "",
  );
  if (running) return CIState.Running;

  const cancels = actions.filter(
    (s) =>
      s.conclusion !== undefined && INFRA_CANCEL_CONCLUSIONS.has(s.conclusion),
  );
  if (cancels.length >= 2) return CIState.CancelledRetried;
  if (cancels.length === 1) return CIState.Cancelled;

  return CIState.Passed;
}
