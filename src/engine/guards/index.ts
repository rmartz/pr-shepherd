// Atomic-task guards (Epic 10, #101): the cross-cutting, pure decisions that
// make atomic tasks safe to re-run — the one-shot CI rerun guard, settle windows
// after label writes, idempotency keys for mutating steps, and atomic verdict-
// label reconciliation. See `docs/subsystems/atomic-task-guards.md`.
export {
  MAX_RERUNS_PER_COMMIT,
  RerunVerdict,
  recordRerun,
  rerunGuard,
  type RerunLedger,
} from "./rerun-guard";
export {
  idempotencyKey,
  isAlreadyApplied,
  type AppliedKeys,
  type IdempotencyTarget,
} from "./idempotency";
export {
  DEFAULT_SETTLE_MS,
  SettleVerdict,
  settleGuard,
  type SettleInput,
} from "./settle-window";
export {
  VerdictLabel,
  healVerdict,
  reconcileVerdict,
  type LabelMutation,
} from "./verdict-labels";
