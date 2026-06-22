import type { IssueCommentSnapshot } from "@/engine/derivation";
import { latestOutcomePerSkill, newCommentSinceOutcome } from "./derive";
import { SkillOutcome } from "./types";

// ---------------------------------------------------------------------------
// Harness routing on outcome metadata (Epic 11, #151).
//
// The bridge between the decide layer (gates, Epic 10) and the
// execute/resilience layer (retry, stall defense, loop detection — #105/#107/
// #110): all of those consumers key off the SAME outcome record instead of
// re-deriving "did the last step succeed / what did it decide". `routeOnOutcome`
// inspects the most recent outcome comment for a skill and returns a single
// routing directive.
//
// Precedence (first match wins), encoding the issue's five rules:
//   1. No outcome record at all              → Retry   (the run produced no
//                                                        record — a healthy run
//                                                        always posts one, so
//                                                        the gap is unambiguous;
//                                                        covers timeout/crash).
//   2. Outcome on a superseded HEAD SHA       → Retry   (stale — re-run against
//                                                        current HEAD).
//   3. `error` outcome                        → Retry   (the skill itself
//                                                        failed; re-run).
//   4. New non-outcome comment since outcome  → Review  (human/Copilot spoke —
//                                                        re-evaluate, never
//                                                        advance on a stale
//                                                        approve).
//   5. `hard_reject`                          → Escalate.
//   6. `approve`                              → Advance.
//   7. `soft_reject`                          → Fix.
//   8. `no_op`                                → Idle.
//
// `Retry` covers timeout-without-outcome AND stale-HEAD AND error because all
// three mean "this step has no usable current verdict; run it again".
// ---------------------------------------------------------------------------

export enum OutcomeRoute {
  // Advance to the next gate/step — the gate is satisfied on current HEAD.
  Advance = "advance",
  // Stop auto-driving; a human must intervene.
  Escalate = "escalate",
  // Route to the fix step — changes requested but converging.
  Fix = "fix",
  // Nothing to do this cycle (legitimate idle).
  Idle = "idle",
  // Re-run the step — no usable current outcome (missing / stale / errored).
  Retry = "retry",
  // Return to the review step to re-evaluate (new external comment landed).
  Review = "review",
}

export interface RouteOnOutcomeParams {
  comments: IssueCommentSnapshot[];
  // The skill whose outcome governs this step (`review`, `merge`, …).
  skill: string;
  // The PR's current HEAD SHA. An outcome computed against any other SHA is
  // stale and forces a re-run.
  currentHeadSha: string;
}

export function routeOnOutcome(params: RouteOnOutcomeParams): OutcomeRoute {
  const latest = latestOutcomePerSkill(params.comments).get(params.skill);

  // Rule 1: no record at all → the run left no verdict → retry.
  if (latest === undefined) return OutcomeRoute.Retry;

  // Rule 2: outcome computed against a superseded HEAD → stale → retry.
  if (latest.record.headSha !== params.currentHeadSha)
    return OutcomeRoute.Retry;

  // Rule 3: the skill itself failed → retry.
  if (latest.record.outcome === SkillOutcome.Error) return OutcomeRoute.Retry;

  // Rule 4: an external comment landed after the outcome → re-review rather
  // than acting on a now-stale verdict.
  if (newCommentSinceOutcome(params.comments, params.skill)) {
    return OutcomeRoute.Review;
  }

  // Rules 5–8: route on the verdict itself. `Error` is already handled by
  // rule 3, so the remaining members map one-to-one to a route.
  switch (latest.record.outcome) {
    case SkillOutcome.Approve:
      return OutcomeRoute.Advance;
    case SkillOutcome.HardReject:
      return OutcomeRoute.Escalate;
    case SkillOutcome.SoftReject:
      return OutcomeRoute.Fix;
    case SkillOutcome.NoOp:
      return OutcomeRoute.Idle;
  }
}
