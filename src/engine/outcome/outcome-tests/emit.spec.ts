import { describe, expect, it } from "vitest";
import { GithubActionSchema, GithubActionType } from "@/steps/githubApi";
import { buildOutcomeAction } from "../emit";
import { parseOutcomeMarker } from "../marker";
import { SkillOutcome } from "../types";
import { makeOutcomeRecord } from "./fixtures";

describe("Shared emitter builds a capability-isolated post_comment action", () => {
  it("emits a post_comment github_api action carrying the record", () => {
    const record = makeOutcomeRecord({ outcome: SkillOutcome.SoftReject });
    const action = buildOutcomeAction({
      repo: "rmartz/pr-shepherd",
      pr: 42,
      record,
    });

    expect(action.type).toBe(GithubActionType.PostComment);
    // Action validates against the github_api schema — proving it flows through
    // the same queue (and concurrency budget) as every other mutation.
    expect(() => GithubActionSchema.parse(action)).not.toThrow();
  });

  it("embeds a marker the derivation layer can parse back", () => {
    const record = makeOutcomeRecord({
      outcome: SkillOutcome.Approve,
      stepInstanceId: "step-77",
    });
    const action = buildOutcomeAction({
      repo: "rmartz/pr-shepherd",
      pr: 42,
      record,
    });
    const body = (action.params as { body: string }).body;

    expect(parseOutcomeMarker(body)).toEqual(record);
  });
});
