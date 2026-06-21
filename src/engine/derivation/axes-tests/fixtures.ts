import type {
  CheckSuiteSnapshot,
  CommitStatusSnapshot,
  IssueCommentSnapshot,
  PrSnapshot,
  ReviewSnapshot,
  ReviewThreadSnapshot,
} from "../types";

// Fixture builders for axis-derivation tests. `makePrSnapshot` returns a
// CLEAN, never-reviewed, passing baseline; each test overrides only the fields
// relevant to the axis under test so a failure points at one cause.

export function makePrSnapshot(
  overrides: Partial<PrSnapshot> = {},
): PrSnapshot {
  return {
    owner: "rmartz",
    repo: "pr-shepherd",
    number: 7,
    title: "Add a thing",
    body: "",
    isDraft: false,
    mergeable: "MERGEABLE",
    baseRefName: "main",
    headRefName: "feat/thing",
    author: "rmartz",
    headOid: "oid-head",
    labels: [],
    commitOids: ["oid-old", "oid-head"],
    checkSuites: [],
    commitStatuses: [],
    reviews: [],
    reviewThreads: [],
    issueComments: [],
    fetchedAt: 1_000_000,
    ...overrides,
  };
}

export function makeCheckSuite(
  overrides: Partial<CheckSuiteSnapshot> = {},
): CheckSuiteSnapshot {
  return {
    appName: "GitHub Actions",
    workflowName: "CI",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    ...overrides,
  };
}

export function makeCommitStatus(
  overrides: Partial<CommitStatusSnapshot> = {},
): CommitStatusSnapshot {
  return {
    context: "Vercel",
    state: "SUCCESS",
    description: undefined,
    targetUrl: undefined,
    ...overrides,
  };
}

export function makeReview(
  overrides: Partial<ReviewSnapshot> = {},
): ReviewSnapshot {
  return {
    id: 1,
    author: "reviewer",
    state: "APPROVED",
    submittedAt: "2026-06-15T00:00:00Z",
    commitOid: "oid-head",
    body: "",
    ...overrides,
  };
}

export function makeReviewThread(
  overrides: Partial<ReviewThreadSnapshot> = {},
): ReviewThreadSnapshot {
  return {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    firstCommentAuthor: "reviewer",
    ...overrides,
  };
}

export function makeIssueComment(
  overrides: Partial<IssueCommentSnapshot> = {},
): IssueCommentSnapshot {
  return {
    id: 1,
    author: "rmartz",
    body: "",
    createdAt: "2026-06-15T00:00:00Z",
    ...overrides,
  };
}
