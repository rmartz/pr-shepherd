import { describe, expect, it } from "vitest";
import { parseOutcomeMarker, renderOutcomeMarker } from "../marker";
import { SkillOutcome } from "../types";
import { makeOutcomeRecord } from "./fixtures";

describe("Outcome metadata format is parseable from PR comment text", () => {
  it("round-trips a full record through render then parse", () => {
    const record = makeOutcomeRecord({
      skill: "merge",
      skillVersion: "v7",
      gitHash: "abc1234",
      outcome: SkillOutcome.HardReject,
      runId: "run-42",
      stepInstanceId: "step-9",
      headSha: "head-xyz",
      timestamp: "2026-06-20T09:30:00Z",
    });
    expect(parseOutcomeMarker(renderOutcomeMarker(record))).toEqual(record);
  });

  it("parses the marker when wrapped in a human-readable comment body", () => {
    const record = makeOutcomeRecord({ outcome: SkillOutcome.SoftReject });
    const body = `Some prose above.\n\n${renderOutcomeMarker(record)}\n\nprose below`;
    expect(parseOutcomeMarker(body)?.outcome).toBe(SkillOutcome.SoftReject);
  });

  it("returns undefined for a comment with no marker", () => {
    expect(parseOutcomeMarker("just a normal review comment")).toBeUndefined();
  });

  it("returns undefined when the marker JSON is malformed", () => {
    expect(
      parseOutcomeMarker("<!-- skill-outcome: {not json} -->"),
    ).toBeUndefined();
  });

  it("returns undefined when the outcome is outside the closed enum", () => {
    const body = renderOutcomeMarker(makeOutcomeRecord()).replace(
      '"approve"',
      '"maybe"',
    );
    expect(parseOutcomeMarker(body)).toBeUndefined();
  });

  it("returns undefined when a required field is missing", () => {
    const body = renderOutcomeMarker(makeOutcomeRecord()).replace(
      /,"head_sha":"[^"]*"/,
      "",
    );
    expect(parseOutcomeMarker(body)).toBeUndefined();
  });
});
