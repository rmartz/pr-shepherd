import { z } from "zod";
import { WebhookEventType } from "./enums";

// Schema for the `webhookEvents` collection. See Vision §13.1, §15 and
// Epic 12 (#111).
//
// Each document is a *raw* GitHub webhook delivery, persisted verbatim
// before any processing so deliveries are durable and replay-safe. The
// document `id` is the GitHub delivery id (`X-GitHub-Delivery` header),
// which GitHub guarantees unique per delivery — so re-delivery of the
// same event is idempotent: the second write collides on the same id
// and is dropped rather than re-processed (#111 acceptance criterion 2).
//
// `eventType` is the `X-GitHub-Event` header (one of the subscribed
// types in `WebhookEventType`). `payload` is the parsed JSON body kept
// as an opaque record — later epics (#112+) interpret it; the receiver
// stores it untouched. `receivedAt` is the daemon/ingress wall-clock
// time the delivery was accepted, used for ordering and replay windows.
export const WebhookEventSchema = z
  .object({
    id: z.string().min(1),
    deliveryId: z.string().min(1),
    eventType: z.enum(WebhookEventType),
    payload: z.record(z.string(), z.unknown()),
    receivedAt: z.number().int().nonnegative(),
  })
  .strict();

export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
