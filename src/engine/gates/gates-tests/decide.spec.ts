import { describe, expect, it } from "vitest";

import {
  CIState,
  CopilotState,
  HoldState,
  MergeConflict,
  ReviewState,
  ThreadState,
  UATState,
} from "../../derivation/state-vector";
import { Action, Gate, decide } from "../index";
import { makePrStateVector } from "./fixtures";

describe("decide() — fully satisfied PR merges", () => {
  it("returns MERGE on the terminal gate when every gate passes", () => {
    expect(decide(makePrStateVector())).toEqual({
      action: Action.Merge,
      blockingGate: Gate.Merge,
    });
  });
});

describe("decide() — NOT_WIP gate", () => {
  it("parks a WIP PR", () => {
    expect(decide(makePrStateVector({ hold: HoldState.Wip }))).toEqual({
      action: Action.Park,
      blockingGate: Gate.NotWip,
    });
  });

  it("parks a draft PR", () => {
    expect(decide(makePrStateVector({ hold: HoldState.Draft }))).toEqual({
      action: Action.Park,
      blockingGate: Gate.NotWip,
    });
  });
});

describe("decide() — NO_HOLD gate", () => {
  it("parks an escalation hold", () => {
    expect(
      decide(makePrStateVector({ hold: HoldState.EscalationNeeded })),
    ).toEqual({ action: Action.Park, blockingGate: Gate.NoHold });
  });

  it("parks a blocked-on-issue hold", () => {
    expect(
      decide(makePrStateVector({ hold: HoldState.BlockedOnIssue })),
    ).toEqual({ action: Action.Park, blockingGate: Gate.NoHold });
  });

  it("skips the hold when also CONFLICTING — the conflict resolves regardless", () => {
    expect(
      decide(
        makePrStateVector({
          hold: HoldState.EscalationNeeded,
          conflict: MergeConflict.Conflicting,
        }),
      ),
    ).toEqual({ action: Action.FixReview, blockingGate: Gate.NoConflict });
  });
});

describe("decide() — CI_GREEN gate", () => {
  it("authorizes CI when it needs auth", () => {
    expect(decide(makePrStateVector({ ci: CIState.NeedsAuth }))).toEqual({
      action: Action.AuthorizeCi,
      blockingGate: Gate.CiGreen,
    });
  });

  it("reruns a cancelled CI run", () => {
    expect(decide(makePrStateVector({ ci: CIState.Cancelled }))).toEqual({
      action: Action.RerunCi,
      blockingGate: Gate.CiGreen,
    });
  });

  it("escalates an already-retried cancel — one-shot rerun spent, surface a human", () => {
    expect(decide(makePrStateVector({ ci: CIState.CancelledRetried }))).toEqual(
      { action: Action.Escalate, blockingGate: Gate.CiGreen },
    );
  });

  it("parks (does not re-escalate) once the escalation label is applied", () => {
    // With the sticky `escalation needed` hold present, NoHold parks before
    // CiGreen is reached — so the escalate action fires exactly once (#253).
    expect(
      decide(
        makePrStateVector({
          ci: CIState.CancelledRetried,
          hold: HoldState.EscalationNeeded,
        }),
      ),
    ).toEqual({ action: Action.Park, blockingGate: Gate.NoHold });
  });

  it("re-enters review once escalation clears and CI recovers, with the verdict stripped", () => {
    // The human cleared `escalation needed` and re-ran CI to green; the stripped
    // approval means the PR gets a fresh review rather than merging on a stale
    // verdict (#253).
    expect(
      decide(
        makePrStateVector({
          ci: CIState.Passed,
          hold: HoldState.None,
          review: ReviewState.Unreviewed,
        }),
      ),
    ).toEqual({ action: Action.Review, blockingGate: Gate.CodeApproved });
  });

  it("waits on running CI", () => {
    expect(decide(makePrStateVector({ ci: CIState.Running }))).toEqual({
      action: Action.WaitCi,
      blockingGate: Gate.CiGreen,
    });
  });

  it("routes a never-reviewed CI-failing PR to REVIEW, not FIX_REVIEW", () => {
    expect(
      decide(
        makePrStateVector({
          ci: CIState.Failing,
          review: ReviewState.Unreviewed,
        }),
      ),
    ).toEqual({ action: Action.Review, blockingGate: Gate.CiGreen });
  });

  it("routes a reviewed CI-failing PR to FIX_REVIEW", () => {
    expect(
      decide(
        makePrStateVector({
          ci: CIState.Failing,
          review: ReviewState.ChangesRequested,
        }),
      ),
    ).toEqual({ action: Action.FixReview, blockingGate: Gate.CiGreen });
  });
});

describe("decide() — NO_CONFLICT gate", () => {
  it("fix-reviews a conflicting branch", () => {
    expect(
      decide(makePrStateVector({ conflict: MergeConflict.Conflicting })),
    ).toEqual({ action: Action.FixReview, blockingGate: Gate.NoConflict });
  });

  it("waits on the remote when mergeability is unknown", () => {
    expect(
      decide(makePrStateVector({ conflict: MergeConflict.Unknown })),
    ).toEqual({ action: Action.WaitRemote, blockingGate: Gate.NoConflict });
  });
});

describe("decide() — CODE_APPROVED gate", () => {
  it("reviews an unreviewed PR", () => {
    expect(
      decide(makePrStateVector({ review: ReviewState.Unreviewed })),
    ).toEqual({ action: Action.Review, blockingGate: Gate.CodeApproved });
  });

  it("reviews a PR awaiting re-review (new commits stripped a standing APPROVED)", () => {
    expect(
      decide(makePrStateVector({ review: ReviewState.AwaitingReReview })),
    ).toEqual({ action: Action.Review, blockingGate: Gate.CodeApproved });
  });

  it("fix-reviews a PR with changes requested", () => {
    expect(
      decide(makePrStateVector({ review: ReviewState.ChangesRequested })),
    ).toEqual({ action: Action.FixReview, blockingGate: Gate.CodeApproved });
  });
});

describe("decide() — THREADS_RESOLVED gate", () => {
  it("reviews to reconcile open review threads", () => {
    expect(decide(makePrStateVector({ threads: ThreadState.Open }))).toEqual({
      action: Action.Review,
      blockingGate: Gate.ThreadsResolved,
    });
  });
});

describe("decide() — COPILOT_SETTLED gate", () => {
  it("waits on Copilot when its review is pending", () => {
    expect(
      decide(makePrStateVector({ copilot: CopilotState.AwaitingReview })),
    ).toEqual({
      action: Action.WaitCopilot,
      blockingGate: Gate.CopilotSettled,
    });
  });

  it("fix-reviews open Copilot threads", () => {
    expect(
      decide(makePrStateVector({ copilot: CopilotState.HasOpenThreads })),
    ).toEqual({ action: Action.FixReview, blockingGate: Gate.CopilotSettled });
  });

  it("is satisfied when copilotUnavailable, regardless of the copilot axis", () => {
    expect(
      decide(makePrStateVector({ copilot: CopilotState.AwaitingReview }), {
        copilotUnavailable: true,
      }),
    ).toEqual({ action: Action.Merge, blockingGate: Gate.Merge });
  });
});

describe("decide() — UAT_CLEARED gate", () => {
  it("parks a PR pending a UAT decision", () => {
    expect(
      decide(makePrStateVector({ uat: UATState.DecisionPending })),
    ).toEqual({ action: Action.Park, blockingGate: Gate.UatCleared });
  });

  it("parks a ready-but-untested PR", () => {
    expect(decide(makePrStateVector({ uat: UATState.ReadyUntested }))).toEqual({
      action: Action.Park,
      blockingGate: Gate.UatCleared,
    });
  });

  it("is satisfied when skipUat, regardless of the uat axis", () => {
    expect(
      decide(makePrStateVector({ uat: UATState.ReadyUntested }), {
        skipUat: true,
      }),
    ).toEqual({ action: Action.Merge, blockingGate: Gate.Merge });
  });
});

describe("decide() — MERGE gate (DO_NOT_MERGE is a merge-only hold)", () => {
  it("parks a DO_NOT_MERGE PR only at the terminal gate", () => {
    expect(decide(makePrStateVector({ hold: HoldState.DoNotMerge }))).toEqual({
      action: Action.Park,
      blockingGate: Gate.Merge,
    });
  });

  it("still reviews a DO_NOT_MERGE PR that is otherwise unreviewed", () => {
    expect(
      decide(
        makePrStateVector({
          hold: HoldState.DoNotMerge,
          review: ReviewState.Unreviewed,
        }),
      ),
    ).toEqual({ action: Action.Review, blockingGate: Gate.CodeApproved });
  });

  it("still runs CI for a DO_NOT_MERGE PR with CI pending auth", () => {
    expect(
      decide(
        makePrStateVector({
          hold: HoldState.DoNotMerge,
          ci: CIState.NeedsAuth,
        }),
      ),
    ).toEqual({ action: Action.AuthorizeCi, blockingGate: Gate.CiGreen });
  });
});
