import type { SkillOutcomeRecord } from "@/engine/outcome";

// ---------------------------------------------------------------------------
// Convergence assessment (issue #105).
//
// A fix→review loop that never converges is caught by a periodic
// self-reflection (an `assess-progress` evaluation, run by a skill) that judges
// converging-vs-flapping and escalates ONLY flappers — deliberately NOT a hard
// round cap, which would wrongly punish a genuinely large PR that is still
// making progress.
//
// This module owns the engine-side pieces: the reflection *cadence* (driven by
// a DURABLE review count read off the PR's skill-outcome markers, so it
// survives daemon restarts/timeouts) and the mapping from the reflection's
// verdict to an action. The judgment itself is the skill's; the engine decides
// when to ask and what to do with the answer.
// ---------------------------------------------------------------------------

// The `assess-progress` reflection's judgment.
export enum ConvergenceVerdict {
  Converging = "converging",
  Flapping = "flapping",
}

// What the daemon does with that judgment.
export enum ConvergenceAction {
  Continue = "continue",
  Escalate = "escalate",
}

const DEFAULT_EVERY_N_REVIEWS = 3;

// The durable review count: how many `review` outcomes the PR carries. Read
// from the skill-outcome markers (#151) rather than in-memory state, so the
// cadence is stable across restarts.
export function durableReviewCount(
  outcomes: readonly SkillOutcomeRecord[],
): number {
  return outcomes.filter((outcome) => outcome.skill === "review").length;
}

// Whether to run the `assess-progress` reflection this cycle — every N reviews
// by the durable count (never at zero, so a fresh PR isn't reflected on).
export function shouldAssessProgress(
  reviewCount: number,
  options: { everyNReviews?: number } = {},
): boolean {
  const everyNReviews = options.everyNReviews ?? DEFAULT_EVERY_N_REVIEWS;
  return reviewCount > 0 && reviewCount % everyNReviews === 0;
}

// Map a reflection verdict to an action: escalate only flappers.
export function resolveConvergence(
  verdict: ConvergenceVerdict,
): ConvergenceAction {
  return verdict === ConvergenceVerdict.Flapping
    ? ConvergenceAction.Escalate
    : ConvergenceAction.Continue;
}
