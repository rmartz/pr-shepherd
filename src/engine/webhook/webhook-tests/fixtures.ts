import { WebhookEventType, type WebhookEvent } from "@/db/schemas";
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
