import type { IssueCommentSnapshot } from "@/engine/derivation";
import { renderOutcomeMarker } from "../marker";
import { SkillOutcome, type SkillOutcomeRecord } from "../types";

// Fixture builders for the skill-outcome protocol tests. `makeOutcomeRecord`
// returns a fully-populated `approve` record on a known HEAD; each test
// overrides only the fields under test so a failure points at one cause.

export function makeOutcomeRecord(
  overrides: Partial<SkillOutcomeRecord> = {},
): SkillOutcomeRecord {
  return {
    skill: "review",
    skillVersion: "v3",
    gitHash: "deadbeef",
    outcome: SkillOutcome.Approve,
    runId: "run-1",
    stepInstanceId: "step-1",
    headSha: "head-current",
    timestamp: "2026-06-20T12:00:00Z",
    ...overrides,
  };
}

export function makeOutcomeComment(
  record: SkillOutcomeRecord,
  overrides: Partial<IssueCommentSnapshot> = {},
): IssueCommentSnapshot {
  return {
    id: 100,
    author: "pr-shepherd[bot]",
    body: `**\`/${record.skill}\` outcome** ${renderOutcomeMarker(record)}`,
    createdAt: record.timestamp,
    ...overrides,
  };
}

export function makePlainComment(
  overrides: Partial<IssueCommentSnapshot> = {},
): IssueCommentSnapshot {
  return {
    id: 200,
    author: "rmartz",
    body: "please address the failing test",
    createdAt: "2026-06-20T13:00:00Z",
    ...overrides,
  };
}
