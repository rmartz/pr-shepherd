// Public surface of the convergence module (issue #105).
//
// `detectSameActionLoop` stops obvious spins (same action + unchanged state);
// `shouldAssessProgress` / `durableReviewCount` drive the convergence
// reflection's cadence off durable review markers; `resolveConvergence` maps
// the reflection verdict to continue-or-escalate.
export {
  detectSameActionLoop,
  LoopVerdict,
  type ActionTick,
} from "./loopDetection";
export {
  ConvergenceAction,
  ConvergenceVerdict,
  durableReviewCount,
  resolveConvergence,
  shouldAssessProgress,
} from "./convergence";
