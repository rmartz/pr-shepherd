import { describe, it, expect } from "vitest";
import { WebhookEventType } from "@/db/schemas";
import { eventToTargets, isBranchTarget } from "./event-target";
import {
  makeCheckRunPayload,
  makeCheckSuitePayload,
  makeIssueCommentPayload,
  makePullRequestPayload,
  makePushPayload,
  makeReviewPayload,
  makeReviewThreadPayload,
  makeWebhookEvent,
  TEST_REPO,
} from "./webhook-tests/fixtures";

// ---------------------------------------------------------------------------
// `eventToTargets` is the pure event → affected-PR mapping (#112 criterion 1).
// Each subscribed event type names the PR in a different payload location;
// these tests pin the extraction per type, plus the clean-drop cases that
// produce no target (#112 criterion 2).
// ---------------------------------------------------------------------------

describe("eventToTargets maps each subscribed event type to its affected PR", () => {
  it("maps a check_run completion to its associated PR number", () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.CheckRun,
      payload: makeCheckRunPayload([42]),
    });

    expect(eventToTargets(event)).toEqual([{ repo: TEST_REPO, prNumber: 42 }]);
  });

  it("maps a check_suite completion to its associated PR number", () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.CheckSuite,
      payload: makeCheckSuitePayload([42]),
    });

    expect(eventToTargets(event)).toEqual([{ repo: TEST_REPO, prNumber: 42 }]);
  });

  it("maps a pull_request_review_thread event to its PR number", () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.PullRequestReviewThread,
      payload: makeReviewThreadPayload(17),
    });

    expect(eventToTargets(event)).toEqual([{ repo: TEST_REPO, prNumber: 17 }]);
  });

  it("maps a pull_request_review submission to its PR number", () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.PullRequestReview,
      payload: makeReviewPayload(13),
    });

    expect(eventToTargets(event)).toEqual([{ repo: TEST_REPO, prNumber: 13 }]);
  });

  it("maps a push to the branch it updated", () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.Push,
      payload: makePushPayload("feat/widget"),
    });
    const targets = eventToTargets(event);

    expect(targets).toHaveLength(1);
    const [target] = targets;
    expect(isBranchTarget(target!)).toBe(true);
    expect(target).toEqual({ repo: TEST_REPO, branch: "feat/widget" });
  });

  it("maps a pull_request event to its PR number", () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.PullRequest,
      payload: makePullRequestPayload(9, "opened"),
    });

    expect(eventToTargets(event)).toEqual([{ repo: TEST_REPO, prNumber: 9 }]);
  });

  it("maps a PR-scoped issue_comment to the PR number", () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.IssueComment,
      payload: makeIssueCommentPayload(5, true),
    });

    expect(eventToTargets(event)).toEqual([{ repo: TEST_REPO, prNumber: 5 }]);
  });

  it("expands a check_suite spanning multiple PRs into one target each", () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.CheckSuite,
      payload: makeCheckSuitePayload([1, 2]),
    });

    expect(eventToTargets(event)).toEqual([
      { repo: TEST_REPO, prNumber: 1 },
      { repo: TEST_REPO, prNumber: 2 },
    ]);
  });
});

describe("eventToTargets drops events that name no PR", () => {
  it("yields no target for an issue_comment on a plain issue", () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.IssueComment,
      payload: makeIssueCommentPayload(5, false),
    });

    expect(eventToTargets(event)).toEqual([]);
  });

  it("yields no target for a branch-delete push", () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.Push,
      payload: { ...makePushPayload("gone"), deleted: true },
    });

    expect(eventToTargets(event)).toEqual([]);
  });

  it("yields no target for a tag push", () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.Push,
      payload: {
        ref: "refs/tags/v1.0.0",
        repository: { full_name: TEST_REPO },
      },
    });

    expect(eventToTargets(event)).toEqual([]);
  });

  it("yields no target when the payload omits repository", () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.PullRequest,
      payload: { number: 7, pull_request: { number: 7 } },
    });

    expect(eventToTargets(event)).toEqual([]);
  });

  it("yields no target for a check_suite with no associated PRs", () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.CheckSuite,
      payload: makeCheckSuitePayload([]),
    });

    expect(eventToTargets(event)).toEqual([]);
  });
});
