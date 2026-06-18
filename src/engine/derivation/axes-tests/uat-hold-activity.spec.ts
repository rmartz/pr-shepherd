import { describe, it, expect } from "vitest";
import { derivePrState } from "../axes";
import { Activity, HoldState, UATState } from "../state-vector";
import { makeIssueComment, makePrSnapshot, makeReview } from "./fixtures";

describe("UATState: NOT_REQUIRED is the default", () => {
  it("is NOT_REQUIRED with no UAT label and no approval", () => {
    expect(derivePrState(makePrSnapshot()).uat).toBe(UATState.NotRequired);
  });
});

describe("UATState: progresses with labels", () => {
  it("is READY_UNTESTED when the PR carries 'ready for UAT'", () => {
    const snap = makePrSnapshot({ labels: ["ready for UAT"] });
    expect(derivePrState(snap).uat).toBe(UATState.ReadyUntested);
  });

  it("is TESTED once the 'tested' label lands", () => {
    const snap = makePrSnapshot({ labels: ["ready for UAT", "tested"] });
    expect(derivePrState(snap).uat).toBe(UATState.Tested);
  });

  it("is DECISION_PENDING when UAT is required but no readiness/result is set", () => {
    const snap = makePrSnapshot({ labels: ["needs UAT"] });
    expect(derivePrState(snap).uat).toBe(UATState.DecisionPending);
  });
});

describe("HoldState: NONE by default", () => {
  it("is NONE for a plain non-draft PR", () => {
    expect(derivePrState(makePrSnapshot()).hold).toBe(HoldState.None);
  });
});

describe("HoldState: drafts and WIP", () => {
  it("is DRAFT for a draft PR", () => {
    expect(derivePrState(makePrSnapshot({ isDraft: true })).hold).toBe(
      HoldState.Draft,
    );
  });

  it("is WIP when the title is prefixed [WIP]", () => {
    const snap = makePrSnapshot({ title: "[WIP] Add a thing" });
    expect(derivePrState(snap).hold).toBe(HoldState.Wip);
  });
});

describe("HoldState: do-not-merge label", () => {
  it("is DO_NOT_MERGE for a 'do not merge' label", () => {
    expect(
      derivePrState(makePrSnapshot({ labels: ["do not merge"] })).hold,
    ).toBe(HoldState.DoNotMerge);
  });

  it("is DO_NOT_MERGE for the 'dnm' label", () => {
    expect(derivePrState(makePrSnapshot({ labels: ["dnm"] })).hold).toBe(
      HoldState.DoNotMerge,
    );
  });
});

describe("HoldState: blocked-on-issue auto-resume", () => {
  it("is BLOCKED_ON_ISSUE while the referenced issue is open", () => {
    const snap = makePrSnapshot({
      issueComments: [makeIssueComment({ body: "blocked on #42 for now" })],
    });
    const vector = derivePrState(snap, { openIssueNumbers: [42] });
    expect(vector.hold).toBe(HoldState.BlockedOnIssue);
  });

  it("auto-resumes (NONE) once the referenced issue closes", () => {
    const snap = makePrSnapshot({
      issueComments: [makeIssueComment({ body: "blocked on #42" })],
    });
    const vector = derivePrState(snap, { openIssueNumbers: [] });
    expect(vector.hold).toBe(HoldState.None);
  });
});

describe("HoldState: escalation", () => {
  it("is ESCALATION_NEEDED for an 'escalation needed' label", () => {
    const snap = makePrSnapshot({ labels: ["escalation needed"] });
    expect(derivePrState(snap).hold).toBe(HoldState.EscalationNeeded);
  });
});

describe("Activity: observational only", () => {
  it("is ACTIVE when activity is recent relative to now", () => {
    const snap = makePrSnapshot({
      fetchedAt: 1_000_000,
      reviews: [makeReview({ submittedAt: "2026-06-15T00:00:00Z" })],
    });
    const vector = derivePrState(snap, {
      now: Date.parse("2026-06-15T00:01:00Z"),
      idleThresholdMs: 86_400_000,
    });
    expect(vector.activity).toBe(Activity.Active);
  });

  it("is IDLE when the newest event predates the idle threshold", () => {
    const snap = makePrSnapshot({
      reviews: [makeReview({ submittedAt: "2026-06-01T00:00:00Z" })],
    });
    const vector = derivePrState(snap, {
      now: Date.parse("2026-06-15T00:00:00Z"),
      idleThresholdMs: 86_400_000,
    });
    expect(vector.activity).toBe(Activity.Idle);
  });

  it("is DELEGATED_WAITING when waiting on a delegate's review", () => {
    const snap = makePrSnapshot({
      reviews: [makeReview({ author: "copilot[bot]", state: "COMMENTED" })],
      reviewThreads: [],
    });
    const vector = derivePrState(snap, {
      delegateLogins: ["copilot"],
      now: Date.parse("2026-06-15T00:00:00Z"),
    });
    expect(vector.activity).toBe(Activity.DelegatedWaiting);
  });
});
