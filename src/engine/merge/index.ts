// Public surface of the merge-serialization module (issue #104).
//
// `createMergeCoordinator` is the single global merge path (mutex + idempotency
// + lag). `assessMergeReadiness` is the pre-merge re-validation of the volatile
// axes. `needsBranchSync` decides whether a behind-`main` branch must be synced
// before merging.
export {
  createMergeCoordinator,
  MergeOutcome,
  type MergeAttempt,
  type MergeCoordinator,
} from "./mergeCoordinator";
export { assessMergeReadiness, MergeReadiness } from "./readiness";
export { needsBranchSync, type BranchCurrency } from "./branchCurrency";
