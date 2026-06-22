import { describe, expect, it } from "vitest";
import { OutcomeRoute, routeOnOutcome } from "../route";
import { SkillOutcome } from "../types";
import {
  makeOutcomeComment,
  makeOutcomeRecord,
  makePlainComment,
} from "./fixtures";

const HEAD = "head-current";

describe("Harness routing: retry on timeout without outcome", () => {
  it("retries when no outcome comment exists for the skill", () => {
    const route = routeOnOutcome({
      comments: [makePlainComment()],
      skill: "review",
      currentHeadSha: HEAD,
    });
    expect(route).toBe(OutcomeRoute.Retry);
  });
});

describe("Harness routing: stale on superseded HEAD", () => {
  it("retries when the outcome was computed against an old HEAD", () => {
    const comment = makeOutcomeComment(
      makeOutcomeRecord({ outcome: SkillOutcome.Approve, headSha: "head-old" }),
    );
    const route = routeOnOutcome({
      comments: [comment],
      skill: "review",
      currentHeadSha: HEAD,
    });
    expect(route).toBe(OutcomeRoute.Retry);
  });
});

describe("Harness routing: re-route to review on new comment", () => {
  it("returns to review when a human commented after an approve", () => {
    const approve = makeOutcomeComment(
      makeOutcomeRecord({ outcome: SkillOutcome.Approve }),
      { createdAt: "2026-06-20T10:00:00Z" },
    );
    const human = makePlainComment({ createdAt: "2026-06-20T11:00:00Z" });
    const route = routeOnOutcome({
      comments: [approve, human],
      skill: "review",
      currentHeadSha: HEAD,
    });
    expect(route).toBe(OutcomeRoute.Review);
  });
});

describe("Harness routing: advance on approve", () => {
  it("advances when the latest outcome is approve on current HEAD", () => {
    const approve = makeOutcomeComment(
      makeOutcomeRecord({ outcome: SkillOutcome.Approve }),
    );
    const route = routeOnOutcome({
      comments: [approve],
      skill: "review",
      currentHeadSha: HEAD,
    });
    expect(route).toBe(OutcomeRoute.Advance);
  });
});

describe("Harness routing: escalate on hard_reject", () => {
  it("escalates when the latest outcome is hard_reject", () => {
    const reject = makeOutcomeComment(
      makeOutcomeRecord({ outcome: SkillOutcome.HardReject }),
    );
    const route = routeOnOutcome({
      comments: [reject],
      skill: "review",
      currentHeadSha: HEAD,
    });
    expect(route).toBe(OutcomeRoute.Escalate);
  });
});

describe("Harness routing: remaining verdicts", () => {
  it("routes soft_reject to fix", () => {
    const route = routeOnOutcome({
      comments: [
        makeOutcomeComment(
          makeOutcomeRecord({ outcome: SkillOutcome.SoftReject }),
        ),
      ],
      skill: "review",
      currentHeadSha: HEAD,
    });
    expect(route).toBe(OutcomeRoute.Fix);
  });

  it("routes no_op to idle", () => {
    const route = routeOnOutcome({
      comments: [
        makeOutcomeComment(makeOutcomeRecord({ outcome: SkillOutcome.NoOp })),
      ],
      skill: "review",
      currentHeadSha: HEAD,
    });
    expect(route).toBe(OutcomeRoute.Idle);
  });

  it("retries on a skill-error outcome", () => {
    const route = routeOnOutcome({
      comments: [
        makeOutcomeComment(makeOutcomeRecord({ outcome: SkillOutcome.Error })),
      ],
      skill: "review",
      currentHeadSha: HEAD,
    });
    expect(route).toBe(OutcomeRoute.Retry);
  });
});
