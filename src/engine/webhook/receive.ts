import { Collections } from "@/db/collections";
import { WebhookEventType, type WebhookEvent } from "@/db/schemas";
import type { Db } from "@/db/types";
import { verifySignature } from "./signature";

// Outcome of processing one inbound webhook delivery. The ingress maps
// each variant to an HTTP status; keeping the decision here (not in the
// route) means the topology layer is a thin adapter and every branch is
// unit-testable without HTTP. Alphabetized per the enum convention.
export enum WebhookReceiveResult {
  // Delivery already persisted under this id — re-delivery is a no-op.
  Duplicate = "duplicate",
  // `X-GitHub-Event` is not one of the subscribed types.
  Unsubscribed = "unsubscribed",
  // Signature valid, event subscribed, raw event persisted.
  Stored = "stored",
  // `X-Hub-Signature-256` failed HMAC verification.
  Unauthorized = "unauthorized",
}

export interface ReceiveWebhookInput {
  // Raw request body bytes, exactly as received — the HMAC is computed
  // over these, so any re-serialization would break verification.
  rawBody: string;
  // `X-Hub-Signature-256` header value (`sha256=<hex>`), if present.
  signatureHeader: string | undefined;
  // `X-GitHub-Delivery` — GitHub's per-delivery unique id, used as the
  // persisted document id so re-delivery collides and is dropped.
  deliveryId: string;
  // `X-GitHub-Event` — the event type string.
  eventType: string;
  // The configured webhook secret(s) (supplied by the ingress from the env).
  // An array accepts a delivery signed under any of the secrets, supporting
  // zero-downtime rotation (#114) — see `verifySignature`.
  secret: string | readonly string[];
  // Injected clock for deterministic `receivedAt` in tests.
  now?: () => number;
}

function isSubscribed(eventType: string): eventType is WebhookEventType {
  return (Object.values(WebhookEventType) as string[]).includes(eventType);
}

// Process one inbound delivery: verify the signature, confirm the event
// type is subscribed, then persist the raw event keyed by delivery id
// **before** any downstream processing (#111 criteria 1 & 2). Persistence
// is idempotent: a second delivery with the same id finds the document
// already present and returns `Duplicate` rather than re-storing it.
export async function receiveWebhook(
  db: Db,
  input: ReceiveWebhookInput,
): Promise<WebhookReceiveResult> {
  if (!verifySignature(input.rawBody, input.signatureHeader, input.secret)) {
    return WebhookReceiveResult.Unauthorized;
  }
  if (!isSubscribed(input.eventType)) {
    return WebhookReceiveResult.Unsubscribed;
  }

  const existing = await db.get(Collections.webhookEvents, input.deliveryId);
  if (existing !== undefined) {
    return WebhookReceiveResult.Duplicate;
  }

  const event: WebhookEvent = {
    id: input.deliveryId,
    deliveryId: input.deliveryId,
    eventType: input.eventType,
    payload: JSON.parse(input.rawBody) as Record<string, unknown>,
    receivedAt: (input.now ?? Date.now)(),
  };
  await db.create(Collections.webhookEvents, event);
  return WebhookReceiveResult.Stored;
}
