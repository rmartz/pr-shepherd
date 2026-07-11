import { Action } from "../../gates";
import type { IdempotencyTarget } from "../idempotency";
import type { SettleInput } from "../settle-window";

// A non-default idempotency target: every field is an explicit, distinctive
// value (Test Design: control inputs) so a key assertion proves the join wired
// each component, not an initializer default.
export function makeIdempotencyTarget(
  overrides: Partial<IdempotencyTarget> = {},
): IdempotencyTarget {
  return {
    owner: "acme",
    repo: "widgets",
    prNumber: 4242,
    headSha: "abc123def456",
    ...overrides,
  };
}

// A settle input whose observation already changed (the "visible write" case).
// Tests override exactly the fields under test so a failure points at one cause.
export function makeSettleInput(
  overrides: Partial<SettleInput> = {},
): SettleInput {
  return {
    before: "labels:[approved]",
    after: "labels:[changes requested]",
    settleSpent: false,
    ...overrides,
  };
}

// A rerun ledger built from explicit (commit → count) pairs, so a test never
// relies on an empty-map default to stand in for "no rerun spent".
export function makeRerunLedger(
  entries: readonly (readonly [string, number])[] = [],
): ReadonlyMap<string, number> {
  return new Map(entries);
}

// The default action a fixture keys on when an action value is incidental to the
// assertion — chosen as the highest-stakes mutating action (`merge`).
export const FIXTURE_ACTION = Action.Merge;
