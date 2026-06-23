import {
  type PrSnapshot,
  type ReviewSnapshot,
  type IssueCommentSnapshot,
  ReviewState,
} from "@/engine/derivation";
import type { CopilotLadderInput } from "../requestLadder";

// Fixture builders for the Copilot request-ladder tests. `makeSnapshot` returns
// a CLEAN, never-Copilot-reviewed baseline at HEAD `oid-head`; each test
// overrides only the field under test so a failure points at one cause.

export function makeSnapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
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

export function makeReview(
  overrides: Partial<ReviewSnapshot> = {},
): ReviewSnapshot {
  return {
    id: 1,
    author: "copilot-pull-request-reviewer[bot]",
    state: "COMMENTED",
    submittedAt: "2026-06-15T00:00:00Z",
    commitOid: "oid-head",
    body: "Looks reasonable.",
    ...overrides,
  };
}

export function makeIssueComment(
  overrides: Partial<IssueCommentSnapshot> = {},
): IssueCommentSnapshot {
  return {
    id: 1,
    author: "copilot[bot]",
    body: "",
    createdAt: "2026-06-15T00:00:00Z",
    ...overrides,
  };
}

// A neutral, non-suppressed ladder input over a never-Copilot-reviewed,
// unreviewed PR with nothing requested yet. Tests override per criterion.
export function makeLadderInput(
  overrides: Partial<CopilotLadderInput> = {},
): CopilotLadderInput {
  return {
    snapshot: makeSnapshot(),
    isDependabot: false,
    inInteriorFixReview: false,
    review: ReviewState.Unreviewed,
    sessionRequested: false,
    ...overrides,
  };
}
