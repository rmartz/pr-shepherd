import type { Migration } from "../index";

// Version 1 is the baseline for the `webhookEvents` collection (#111) — the
// raw GitHub webhook delivery store. Documents are written by the webhook
// receiver already conforming to `WebhookEventSchema`, so no data
// transformation is required. The migration exists to stamp
// `_meta/webhookEvents` at version 1 so future migrations have a meaningful
// starting point to compare against.
export const initial: Migration = {
  version: 1,
  up: async () => {
    // Baseline migration — no transformation required.
    await Promise.resolve();
  },
};
