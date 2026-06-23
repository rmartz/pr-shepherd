// ---------------------------------------------------------------------------
// Main-broken circuit breaker (issue #107).
//
// If the most recent `main` push run concluded in `failure`, a post-merge
// regression broke the base. Merging anything onto a broken `main` compounds
// the damage, so the daemon quarantines every PR EXCEPT the designated
// `!`-marked fix-main PR (the change allowed to land the repair). It is
// re-assessed after each in-process merge, so the quarantine lifts the moment a
// fix turns `main` green again.
// ---------------------------------------------------------------------------

const FAILURE = "failure";

export interface MainStatus {
  // Conclusion of the most recent `main` push run (GitHub check conclusion).
  conclusion: string;
  // The `main` HEAD that run was for — captured as the bad SHA when broken.
  sha: string;
}

export interface MainBrokenAssessment {
  broken: boolean;
  // The offending `main` SHA, present only when broken.
  badSha?: string;
}

// `main` is broken when its latest push run concluded in failure.
export function assessMainBroken(latest: MainStatus): MainBrokenAssessment {
  if (latest.conclusion === FAILURE) {
    return { broken: true, badSha: latest.sha };
  }
  return { broken: false };
}

// While `main` is broken, every PR is quarantined except the designated
// `!`-marked fix-main PR allowed to land the repair.
export function isQuarantined(broken: boolean, isFixMainPr: boolean): boolean {
  return broken && !isFixMainPr;
}
