// ---------------------------------------------------------------------------
// Branch currency for the merge path (issue #104).
//
// Being behind `main` is NOT itself a merge blocker — the coordinator merges a
// behind-but-clean branch as-is. A branch is synced only when a sync is
// actually needed: an intervening `main` change the PR overlaps (shared files),
// a breaking change, or a dependency-lockfile PR (stricter — any drift can
// break `--frozen-lockfile`). This mirrors the merge skill's branch-currency
// rule so the daemon doesn't churn CI on syncs that change nothing.
// ---------------------------------------------------------------------------

export interface BranchCurrency {
  // How many commits the PR branch is behind its base.
  behindBy: number;
  // Files changed on `main` since the PR diverged that the PR also touches.
  overlappingFiles: number;
  // The PR (or an intervening main commit) carries a breaking change.
  breakingChange: boolean;
  // The PR modifies a dependency lockfile (package-lock/pnpm-lock/yarn.lock) —
  // held to the stricter "always sync when behind" rule.
  lockfilePr: boolean;
}

// Whether the merge path must sync the branch before merging. Up to date → never.
export function needsBranchSync(currency: BranchCurrency): boolean {
  if (currency.behindBy === 0) return false;
  if (currency.lockfilePr) return true;
  return currency.breakingChange || currency.overlappingFiles > 0;
}
