import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { WebhookEventType } from "@/db/schemas";
import { computeSignature } from "@/engine/webhook";
// `typeof DbModule` (below) is a value query, so this needs the value binding
// and cannot be `import type`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import * as DbModule from "@/db";

// The route imports `createDb` from `@/db`, which would construct a real
// firebase-admin adapter. Replace that factory with the in-memory adapter
// so the handler exercises the real `receiveWebhook` path against a fake
// store — no HTTP server, no Firestore. A single shared db lets each test
// assert persistence side effects.
const db = createInMemoryDb();
vi.mock("@/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  createDb: () => db,
}));

const SECRET = "route-secret";

function makeRequest(
  rawBody: string,
  headers: Record<string, string>,
): Request {
  return new Request("https://example.com/api/webhook/github", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

describe("github webhook route", () => {
  beforeEach(() => {
    process.env["GITHUB_WEBHOOK_SECRET"] = SECRET;
  });

  afterEach(() => {
    delete process.env["GITHUB_WEBHOOK_SECRET"];
    vi.resetModules();
  });

  it("returns 202 and persists a correctly-signed subscribed delivery", async () => {
    const { POST } = await import("./route");
    const rawBody = JSON.stringify({ action: "opened", number: 7 });
    const response = await POST(
      makeRequest(rawBody, {
        "x-github-delivery": "route-delivery-1",
        "x-github-event": WebhookEventType.PullRequest,
        "x-hub-signature-256": computeSignature(rawBody, SECRET),
      }),
    );

    expect(response.status).toBe(202);
    const stored = await db.get(Collections.webhookEvents, "route-delivery-1");
    expect(stored?.deliveryId).toBe("route-delivery-1");
  });

  it("returns 401 for an invalid signature", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      makeRequest(JSON.stringify({ action: "opened" }), {
        "x-github-delivery": "route-delivery-2",
        "x-github-event": WebhookEventType.PullRequest,
        "x-hub-signature-256": "sha256=bad",
      }),
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 when the GitHub delivery headers are missing", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      makeRequest(JSON.stringify({}), {
        "x-hub-signature-256": "sha256=whatever",
      }),
    );

    expect(response.status).toBe(400);
  });

  it("returns 500 when the webhook secret is not configured", async () => {
    delete process.env["GITHUB_WEBHOOK_SECRET"];
    const { POST } = await import("./route");
    const response = await POST(
      makeRequest(JSON.stringify({}), {
        "x-github-delivery": "route-delivery-3",
        "x-github-event": WebhookEventType.PullRequest,
      }),
    );

    expect(response.status).toBe(500);
  });
});
