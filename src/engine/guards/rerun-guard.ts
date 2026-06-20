// ---------------------------------------------------------------------------
// One-shot CI rerun guard (Epic 10, #101).
//
// The gate model (`decide`) already routes a `CANCELLED` CI verdict to
// `RERUN_CI` and a `CANCELLED_RETRIED` verdict to `PARK` (design doc §4.2).
// This guard is the *decision the derivation needs upstream of that*: given the
// commit currently at HEAD and the record of reruns already spent on commits,
// decide whether a fresh infra-cancel may be rerun once more — or whether the
// PR has already used its one shot on this commit and must escalate.
//
// The rule (design doc §4.2, §6 same-action loop): a commit gets **exactly one**
// automated rerun. The first infra-cancel on a commit yields `RerunCi`; a second
// infra-cancel on the *same* commit yields `Escalate`, so a flapping infra
// cancel can never spin the rerun action against itself. A new HEAD commit
// resets the budget — the prior commit's spent rerun does not carry over.
//
// Pure by construction: the caller passes the rerun ledger (commit → count) it
// reads from the durable task records; this function never reads a clock or does
// I/O, so the same inputs always yield the same verdict.
// ---------------------------------------------------------------------------

// The verdict the rerun guard yields for an infra-cancelled CI run.
export enum RerunVerdict {
  // The commit has not yet used its one-shot rerun; rerunning is permitted.
  Rerun = "rerun",
  // The commit already used its one-shot rerun; a second cancel escalates.
  Escalate = "escalate",
}

// A record of how many automated reruns have already been spent, keyed by the
// commit OID the rerun was issued against. The caller builds this from durable
// task records; an absent key means "no rerun spent on that commit yet".
export type RerunLedger = ReadonlyMap<string, number>;

// How many automated reruns a single commit is allowed before escalating. The
// design fixes this at one (a "one-shot" rerun); named so the intent is legible
// and a future change is a single edit.
export const MAX_RERUNS_PER_COMMIT = 1;

// Decide whether an infra-cancelled CI run on `headOid` may be rerun. The
// verdict is purely a function of how many reruns the ledger records for this
// exact commit: below the cap → `Rerun`, at or above → `Escalate`. A different
// HEAD commit starts at zero, so a fresh push always re-earns its one shot.
export function rerunGuard(headOid: string, ledger: RerunLedger): RerunVerdict {
  const spent = ledger.get(headOid) ?? 0;
  return spent < MAX_RERUNS_PER_COMMIT
    ? RerunVerdict.Rerun
    : RerunVerdict.Escalate;
}

// Record that a rerun was issued against `headOid`, returning the updated ledger
// (the input is never mutated). The next `rerunGuard` call for the same commit
// then sees the incremented count and escalates instead of rerunning again.
export function recordRerun(
  headOid: string,
  ledger: RerunLedger,
): ReadonlyMap<string, number> {
  const next = new Map(ledger);
  next.set(headOid, (ledger.get(headOid) ?? 0) + 1);
  return next;
}
