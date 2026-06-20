// ---------------------------------------------------------------------------
// Idempotency keys for mutating steps (Epic 10, #101).
//
// Every effectful action is keyed on `(pr, headSha, action)` (design doc §4,
// §7). Because the lifecycle re-derives state every cycle, the same action can
// be selected twice for the same PR at the same commit — e.g. a crash between
// "merge issued" and "merge observed", or two overlapping cycles. Keying the
// action lets a duplicate execution be recognised and skipped: the second run
// is a safe no-op rather than a double-apply.
//
// `headSha` is part of the key (not just the PR + action) because a new commit
// is a genuinely new action: a `MERGE` of commit A and a `MERGE` of commit B are
// distinct, and a fix-review push that moves HEAD must be allowed to run again.
//
// Pure by construction: key derivation is a deterministic string function, and
// the "already applied?" check reads a caller-supplied set of spent keys (built
// from durable task records). No clock, no I/O.
// ---------------------------------------------------------------------------

import { Action } from "../gates/actions";

// Identifies the PR an action targets. Owner/repo are included so keys are
// globally unique across repositories the daemon drives concurrently.
export interface IdempotencyTarget {
  owner: string;
  repo: string;
  prNumber: number;
  // The HEAD commit OID the action runs against. A new commit yields a new key,
  // so an action re-runs after a push but never double-applies on a fixed HEAD.
  headSha: string;
}

// The set of idempotency keys whose action has already been applied. The caller
// builds this from durable task records; membership means "do not re-apply".
export type AppliedKeys = ReadonlySet<string>;

// Derive the stable idempotency key for `(target, action)`. The format is a
// single delimited string so it can be stored as a Firestore field and compared
// by value. Components are colon-joined in a fixed order; none of them contain a
// colon (owner/repo are GitHub slugs, the number is numeric, the SHA is hex, the
// action is an enum value), so the join is unambiguous.
export function idempotencyKey(
  target: IdempotencyTarget,
  action: Action,
): string {
  return [
    target.owner,
    target.repo,
    target.prNumber,
    target.headSha,
    action,
  ].join(":");
}

// True when the action for `(target, action)` has already been applied and a
// re-execution must be skipped as a no-op. The highest-stakes caller is `merge`
// (design doc §4): a duplicate merge attempt on the same HEAD is recognised here
// and not re-issued.
export function isAlreadyApplied(
  target: IdempotencyTarget,
  action: Action,
  applied: AppliedKeys,
): boolean {
  return applied.has(idempotencyKey(target, action));
}
