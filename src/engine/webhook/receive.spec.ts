import { describe, it, expect } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { WebhookEventType } from "@/db/schemas";
import { receiveWebhook, WebhookReceiveResult } from "./receive";
import { computeSignature } from "./signature";
import { makeReceiveInput, TEST_SECRET } from "./webhook-tests/fixtures";

// ---------------------------------------------------------------------------
// `receiveWebhook` orchestrates verify → subscribe-check → persist. These
// tests assert each branch and the idempotency-by-delivery-id contract
// (#111 acceptance criteria 1, 2, 5).
// ---------------------------------------------------------------------------

describe("receiveWebhook rejects an invalid signature before persisting", () => {
  it("returns Unauthorized and stores nothing for a bad signature", async () => {
    const db = createInMemoryDb();
    const result = await receiveWebhook(
      db,
      makeReceiveInput({ signatureHeader: "sha256=deadbeef" }),
    );

    expect(result).toBe(WebhookReceiveResult.Unauthorized);
    expect(await db.list(Collections.webhookEvents)).toEqual([]);
  });
});

describe("receiveWebhook persists a valid delivery keyed by delivery id", () => {
  it("stores the raw event under the X-GitHub-Delivery id", async () => {
    const db = createInMemoryDb();
    const result = await receiveWebhook(
      db,
      makeReceiveInput({ deliveryId: "delivery-xyz" }),
    );

    expect(result).toBe(WebhookReceiveResult.Stored);
    const stored = await db.get(Collections.webhookEvents, "delivery-xyz");
    expect(stored?.deliveryId).toBe("delivery-xyz");
  });

  it("persists the parsed payload and recorded receivedAt", async () => {
    const db = createInMemoryDb();
    const rawBody = JSON.stringify({ action: "synchronize", number: 42 });
    await receiveWebhook(
      db,
      makeReceiveInput({
        rawBody,
        signatureHeader: computeSignature(rawBody, TEST_SECRET),
        deliveryId: "delivery-payload",
        now: () => 5555,
      }),
    );

    const stored = await db.get(Collections.webhookEvents, "delivery-payload");
    expect(stored?.payload).toEqual({ action: "synchronize", number: 42 });
    expect(stored?.receivedAt).toBe(5555);
  });
});

describe("receiveWebhook is idempotent on re-delivery of the same id", () => {
  it("returns Duplicate and leaves the original document untouched", async () => {
    const db = createInMemoryDb();
    const first = makeReceiveInput({
      deliveryId: "delivery-dup",
      now: () => 1000,
    });
    await receiveWebhook(db, first);

    const second = await receiveWebhook(
      db,
      makeReceiveInput({ deliveryId: "delivery-dup", now: () => 2000 }),
    );

    expect(second).toBe(WebhookReceiveResult.Duplicate);
    const stored = await db.get(Collections.webhookEvents, "delivery-dup");
    // The first write's timestamp survives — the re-delivery did not
    // overwrite the persisted event.
    expect(stored?.receivedAt).toBe(1000);
    expect(await db.list(Collections.webhookEvents)).toHaveLength(1);
  });
});

describe("receiveWebhook rejects unsubscribed event types", () => {
  it("returns Unsubscribed and stores nothing for an unknown event", async () => {
    const db = createInMemoryDb();
    const result = await receiveWebhook(
      db,
      makeReceiveInput({ eventType: "deployment" }),
    );

    expect(result).toBe(WebhookReceiveResult.Unsubscribed);
    expect(await db.list(Collections.webhookEvents)).toEqual([]);
  });

  it("accepts every documented subscribed event type", async () => {
    const db = createInMemoryDb();
    for (const eventType of Object.values(WebhookEventType)) {
      const result = await receiveWebhook(
        db,
        makeReceiveInput({ eventType, deliveryId: `delivery-${eventType}` }),
      );
      expect(result).toBe(WebhookReceiveResult.Stored);
    }
  });
});
