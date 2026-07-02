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
  type MergeBudget,
  type MergeCoordinator,
} from "./mergeCoordinator";
export { assessMergeReadiness, MergeReadiness } from "./readiness";
export { needsBranchSync, type BranchCurrency } from "./branchCurrency";
// Durable merge-attempt budget (#252): error classification + the hidden-marker
// ledger that persists the per-(PR, head SHA) retry count on the PR itself.
export {
  classifyMergeError,
  mergeErrorMessage,
  type MergeErrorClass,
} from "./errorClassification";
export {
  ESCALATION_THRESHOLD,
  buildAttemptMarker,
  countAttempts,
  parseAttemptMarker,
  type AttemptMarker,
} from "./attemptLedger";
