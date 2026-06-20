// ---------------------------------------------------------------------------
// Raw PR state snapshot types (Epic 10, #95).
//
// A `PrSnapshot` is the unprocessed GitHub data needed to derive a PR's state
// vector (#96). It is intentionally a faithful, lightly-typed mirror of what
// GitHub returns — no interpretation happens here; the axis derivation layer
// owns all the "what does this mean" logic. Keeping raw and derived separate
// is what lets the derivation be a pure, exhaustively-testable function.
// ---------------------------------------------------------------------------

export interface PrSnapshotTarget {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface CheckSuiteSnapshot {
  // The GitHub App that produced the suite (e.g. "GitHub Actions"); used by
  // derivation to distinguish Actions suites from third-party check apps.
  appName: string | undefined;
  workflowName: string | undefined;
  status: string;
  conclusion: string | undefined;
}

export interface CommitStatusSnapshot {
  // Commit statuses are the separate channel (e.g. Vercel) that lives apart
  // from GitHub Actions check suites — derivation must treat them distinctly.
  context: string;
  state: string;
  description: string | undefined;
  targetUrl: string | undefined;
}

export interface ReviewSnapshot {
  id: number;
  author: string | undefined;
  state: string;
  submittedAt: string | undefined;
  // The commit the review was submitted against — derivation compares its
  // position in `commitOids` to decide whether the review covers HEAD.
  commitOid: string | undefined;
  body: string;
}

export interface ReviewThreadSnapshot {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  // Author of the thread's first comment — lets derivation attribute a thread
  // to a human vs. the automated reviewer without a second query.
  firstCommentAuthor: string | undefined;
}

export interface IssueCommentSnapshot {
  id: number;
  author: string | undefined;
  body: string;
  createdAt: string | undefined;
}

export interface PrSnapshot {
  owner: string;
  repo: string;
  number: number;
  title: string;
  // The PR-level description body. Carries the Dependabot rebase marker
  // ("Dependabot is rebasing this PR" / "Dependabot rebase failed"), which the
  // dependabot-rebase axis interprets. Distinct from the per-review/comment
  // body fields above — this is the pull request's own description.
  body: string;
  isDraft: boolean;
  // Raw GitHub `mergeable` value ("MERGEABLE" | "CONFLICTING" | "UNKNOWN");
  // passed through verbatim so derivation owns the CLEAN/CONFLICTING/UNKNOWN
  // mapping (and the "UNKNOWN is non-blocking" rule).
  mergeable: string;
  baseRefName: string;
  headRefName: string;
  author: string | undefined;
  headOid: string | undefined;
  labels: string[];
  // Commit OIDs in graph order (oldest → newest); the source of truth for
  // "is this review/CI current" comparisons (position, not timestamp).
  commitOids: string[];
  // Check suites + commit statuses are fetched for the HEAD commit only.
  checkSuites: CheckSuiteSnapshot[];
  commitStatuses: CommitStatusSnapshot[];
  reviews: ReviewSnapshot[];
  reviewThreads: ReviewThreadSnapshot[];
  issueComments: IssueCommentSnapshot[];
  // When this snapshot was assembled (ms epoch) — feeds cache TTL + activity.
  fetchedAt: number;
}

// The injected GitHub read seam — mirrors the `GithubTransport` pattern from
// #46 (github_api) but for reads. Production wires a real `gh`/Octokit
// transport; tests inject a fake that returns scripted responses (including
// rate-limit rejections). `graphql` returns the already-unwrapped `data`
// object; `restPaginate` returns all pages flattened.
export interface GithubReadTransport {
  graphql: <T = unknown>(
    query: string,
    variables: Record<string, unknown>,
  ) => Promise<T>;
  restPaginate: <T = unknown>(
    path: string,
    params?: Record<string, string | number>,
  ) => Promise<T[]>;
}
