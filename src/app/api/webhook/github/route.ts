import { createDb, DbAdapterKind } from "@/db";
import { receiveWebhook, WebhookReceiveResult } from "@/engine/webhook";
import type { Db } from "@/db/types";

// GitHub webhook ingress (Epic 12, #111). This is the **Vercel-forward**
// topology from vision §15: the receiver runs as a Next.js App Router
// route in the Vercel UI app, validates the delivery, and persists the
// raw event to Firestore. The headless daemon then consumes those events
// from Firestore — it never exposes its own HTTP port (ARCHITECTURE.md).
// The alternative **local-tunnel** topology points the same GitHub webhook
// at a tunnel (e.g. cloudflared) into a local process; both terminate in
// this same handler logic, so the receiver code is topology-agnostic.
//
// The handler stays a thin adapter: it reads the raw body and headers,
// delegates verification + persistence to `receiveWebhook`, and maps the
// result enum to an HTTP status. All branching logic lives in the engine
// module so it is unit-testable without a running server.

// The webhook secret is sensitive, so it is read from the environment
// (never `config.yaml`, which is for non-secret operator config). A
// module-cached Db avoids re-initializing the admin SDK per request.
let cachedDb: Db | undefined;

function getDb(): Db {
  // Default to the hosted Firestore (admin SDK) adapter; point at the
  // emulator when `FIRESTORE_EMULATOR_HOST` is set so local-tunnel dev
  // writes land in the emulator the daemon also reads.
  cachedDb ??= createDb({
    adapter:
      process.env["FIRESTORE_EMULATOR_HOST"] !== undefined
        ? DbAdapterKind.FirebaseEmulator
        : DbAdapterKind.FirebaseHosted,
  });
  return cachedDb;
}

const RESULT_STATUS: Record<WebhookReceiveResult, number> = {
  [WebhookReceiveResult.Duplicate]: 200,
  [WebhookReceiveResult.Stored]: 202,
  [WebhookReceiveResult.Unauthorized]: 401,
  [WebhookReceiveResult.Unsubscribed]: 202,
};

export async function POST(request: Request): Promise<Response> {
  const secret = process.env["GITHUB_WEBHOOK_SECRET"];
  if (secret === undefined || secret.length === 0) {
    return new Response("webhook secret not configured", { status: 500 });
  }

  const deliveryId = request.headers.get("x-github-delivery");
  const eventType = request.headers.get("x-github-event");
  if (deliveryId === null || eventType === null) {
    return new Response("missing GitHub delivery headers", { status: 400 });
  }

  const rawBody = await request.text();
  const result = await receiveWebhook(getDb(), {
    rawBody,
    signatureHeader: request.headers.get("x-hub-signature-256") ?? undefined,
    deliveryId,
    eventType,
    secret,
  });

  return new Response(result, { status: RESULT_STATUS[result] });
}
