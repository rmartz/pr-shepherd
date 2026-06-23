import {
  RunStatus,
  StepStatus,
  StepType,
  WebhookEventType,
  type StepInstance,
  type WebhookEvent,
  type WorkflowRun,
} from "@/db/schemas";
import { computeSignature } from "../signature";
import type { ReceiveWebhookInput } from "../receive";

// Shared fixtures for the webhook receiver tests. Each `make{Domain}()`
// returns a fully-valid value with overrides for the fields under test.

export const TEST_SECRET = "shhh-its-a-secret";

export function makeWebhookEvent(
  overrides: Partial<WebhookEvent> = {},
): WebhookEvent {
  return {
    id: "delivery-1",
    deliveryId: "delivery-1",
    eventType: WebhookEventType.PullRequest,
    payload: { action: "opened", number: 7 },
    receivedAt: 1000,
    ...overrides,
  };
}

// Build a `receiveWebhook` input whose `signatureHeader` is, by default, a
// *valid* signature for its `rawBody` — so tests opt into the rejection
// case by overriding `signatureHeader`, never the accept case by accident.
export function makeReceiveInput(
  overrides: Partial<ReceiveWebhookInput> = {},
): ReceiveWebhookInput {
  const rawBody =
    overrides.rawBody ?? JSON.stringify({ action: "opened", number: 7 });
  return {
    rawBody,
    signatureHeader: computeSignature(rawBody, TEST_SECRET),
    deliveryId: "delivery-1",
    eventType: WebhookEventType.PullRequest,
    secret: TEST_SECRET,
    now: () => 1000,
    ...overrides,
  };
}

export const TEST_REPO = "owner/repo";

// A tracked, active run for `TEST_REPO`#7 — the default PR the derivation
// trigger should re-derive. Override `status`/`prNumber`/`repo` to exercise
// the untracked-PR and terminal-run drop paths.
export function makeWorkflowRun(
  overrides: Partial<WorkflowRun> = {},
): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: TEST_REPO,
    prNumber: 7,
    prTitle: "Add a thing",
    status: RunStatus.Running,
    childRunIds: [],
    context: {},
    currentStepId: "derive_pr_state",
    createdAt: 1000,
    updatedAt: 1000,
    metrics: {
      totalClaudeMs: 0,
      totalActiveMs: 0,
      totalScheduleWaitMs: 0,
      totalExternalWaitMs: 0,
    },
    ...overrides,
  };
}

export function makeStepInstance(
  overrides: Partial<StepInstance> = {},
): StepInstance {
  return {
    id: "step-1",
    runId: "run-1",
    stepDefinitionId: "derive_pr_state",
    stepType: StepType.DerivePrState,
    status: StepStatus.Pending,
    input: {},
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1000,
    metrics: {
      claudeMs: 0,
      activeMs: 0,
      scheduleWaitMs: 0,
      externalWaitMs: 0,
    },
    ...overrides,
  };
}

// --- Webhook payload builders ---------------------------------------------
// Each returns a representative GitHub payload for one event type, shaped so
// the event-target mapper can extract the affected PR. `repository.full_name`
// is `TEST_REPO` and the PR number defaults to 7 unless overridden.

export function makePullRequestPayload(
  prNumber = 7,
  action = "synchronize",
): Record<string, unknown> {
  return {
    action,
    number: prNumber,
    pull_request: { number: prNumber },
    repository: { full_name: TEST_REPO },
  };
}

export function makeReviewPayload(prNumber = 7): Record<string, unknown> {
  return {
    action: "submitted",
    review: { state: "approved" },
    pull_request: { number: prNumber },
    repository: { full_name: TEST_REPO },
  };
}

export function makeCheckSuitePayload(
  prNumbers: number[] = [7],
): Record<string, unknown> {
  return {
    action: "completed",
    check_suite: {
      conclusion: "success",
      pull_requests: prNumbers.map((number) => ({ number })),
    },
    repository: { full_name: TEST_REPO },
  };
}

export function makeIssueCommentPayload(
  prNumber = 7,
  isPullRequest = true,
): Record<string, unknown> {
  return {
    action: "created",
    issue: {
      number: prNumber,
      ...(isPullRequest ? { pull_request: { url: "https://x" } } : {}),
    },
    repository: { full_name: TEST_REPO },
  };
}

export function makePushPayload(
  branch = "feat/widget",
): Record<string, unknown> {
  return {
    ref: `refs/heads/${branch}`,
    deleted: false,
    repository: { full_name: TEST_REPO },
  };
}
