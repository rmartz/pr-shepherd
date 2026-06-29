import {
  WebhookEventType,
  type Repository,
  type WebhookEvent,
} from "../../schemas";

// ---------------------------------------------------------------------------
// Domain factory generators for the hosted Firestore adapter tests.
//
// Fake Firestore admin/client implementations live in `fakeAdminQuery.ts`.
// `makeRun` is shared with the in-memory adapter tests and lives in
// `../test-fixtures`.
// ---------------------------------------------------------------------------

export { makeRun } from "../test-fixtures";

export function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "rmartz/pr-shepherd",
    owner: "rmartz",
    name: "pr-shepherd",
    enabled: true,
    workflowMap: { "*": "base-pr" },
    concurrencyMax: 2,
    createdAt: 1716700000000,
    ...overrides,
  };
}

// A webhook delivery received at `receivedAt`. The id/deliveryId derive from
// the timestamp so distinct timestamps are distinct documents — handy for the
// range-query tests, which assert which deliveries fall inside a window.
export function makeEvent(receivedAt: number): WebhookEvent {
  return {
    id: `evt-${String(receivedAt)}`,
    deliveryId: `evt-${String(receivedAt)}`,
    eventType: WebhookEventType.PullRequest,
    payload: { action: "opened" },
    receivedAt,
  };
}
