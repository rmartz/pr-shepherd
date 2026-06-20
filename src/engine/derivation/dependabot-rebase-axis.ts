import type { PrSnapshot } from "./types";
import { DependabotRebaseState } from "./state-vector";

// ---------------------------------------------------------------------------
// Dependabot rebase axis derivation (#199).
//
// Dependabot writes a status line into the PR body while it works:
//   - "Dependabot is rebasing this PR" — AUTHORITATIVE and CURRENT. Dependabot
//     adds it when a rebase begins and removes it when the rebase completes
//     (or replaces it with the failure line). While present, the daemon must
//     NOT post another `@dependabot rebase` (it would be a redundant no-op
//     command); Dependabot re-rebases automatically when `mergeable` flips.
//   - "Dependabot rebase failed" — the terminal failure state. Here a
//     `@dependabot recreate` is usually the right follow-up, not `rebase`.
//
// The failure line is checked first: a body that somehow carried both lines is
// in the failed state, since the in-progress line should have been cleared.
// Matching is case-insensitive and substring-based so surrounding markdown
// (bold, list markers) does not defeat the check. Derivation stays pure — it
// reads only the snapshot body.
// ---------------------------------------------------------------------------

const REBASE_FAILED = /dependabot rebase failed/i;
const REBASE_IN_PROGRESS = /dependabot is rebasing this pr/i;

export function deriveDependabotRebase(
  snapshot: PrSnapshot,
): DependabotRebaseState {
  if (REBASE_FAILED.test(snapshot.body)) return DependabotRebaseState.Failed;
  if (REBASE_IN_PROGRESS.test(snapshot.body)) {
    return DependabotRebaseState.InProgress;
  }
  return DependabotRebaseState.None;
}
