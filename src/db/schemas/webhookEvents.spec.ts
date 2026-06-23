import { describe, it, expect } from "vitest";
import { WebhookEventSchema, WebhookEventType } from "./index";

// Schema round-trip and rejection for the `webhookEvents` collection (#111).

describe("WebhookEventSchema round-trip and rejection", () => {
  const valid = {
    id: "delivery-1",
    deliveryId: "delivery-1",
    eventType: WebhookEventType.PullRequest,
    payload: { action: "opened", number: 7 },
    receivedAt: 1716700000000,
  };

  it("parses a representative valid webhook event", () => {
    expect(WebhookEventSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a webhook event with an unknown field", () => {
    expect(() =>
      WebhookEventSchema.parse({ ...valid, unknownField: "extra" }),
    ).toThrow();
  });

  it("rejects an unsubscribed event type", () => {
    expect(() =>
      WebhookEventSchema.parse({ ...valid, eventType: "deployment" }),
    ).toThrow();
  });

  it("rejects an empty delivery id", () => {
    expect(() =>
      WebhookEventSchema.parse({ ...valid, deliveryId: "" }),
    ).toThrow();
  });
});
