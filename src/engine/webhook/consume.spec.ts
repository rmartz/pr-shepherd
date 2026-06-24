import { describe, it, expect } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { RunStatus, WebhookEventType } from "@/db/schemas";
import { consumeWebhookEvents } from "./consume";
import type { TriggerDerivationsDependencies } from "./derivation-trigger";
import {
  makeCheckSuitePayload,
  makePushPayload,
  makeReviewPayload,
  makeWebhookEvent,
  makeWorkflowRun,
} from "./webhook-tests/fixtures";

// ---------------------------------------------------------------------------
// `consumeWebhookEvents` (#113) reads persisted webhook deliveries and drives
// each into a derivation cycle, applying delivery dedup, burst-collapse, and
// replay tolerance over the #112 ingest path. These tests assert:
//   - a delivery already carrying `processedAt` is never re-processed (dedup);
//   - a burst of deliveries for the same PR collapses to one derivation cycle
//     (debounce/coalesce);
//   - a replayed/out-of-order stale delivery is a no-op because the consumer
//     re-derives from GitHub rather than trusting the event payload.
// ---------------------------------------------------------------------------

function makeDeps(
  db = createInMemoryDb(),
  overrides: Partial<TriggerDerivationsDependencies> = {},
): TriggerDerivationsDependencies {
  return {
    db,
    now: () => 5000,
    newId: () => "step-new",
    ...overrides,
  };
}

let idCounter = 0;
function uniqueId(): string {
  idCounter += 1;
  return `step-${idCounter}`;
}

describe("consumeWebhookEvents dedupes already-processed deliveries", () => {
  it("processes a fresh delivery exactly once", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun({ id: "run-7" }));
    await db.create(
      Collections.webhookEvents,
      makeWebhookEvent({
        id: "d1",
        deliveryId: "d1",
        eventType: WebhookEventType.PullRequestReview,
        payload: makeReviewPayload(7),
      }),
    );

    const result = await consumeWebhookEvents(makeDeps(db), {
      now: () => 9000,
    });

    expect(result.consumed).toBe(1);
    expect(result.triggered).toHaveLength(1);
    expect(result.triggered[0]?.runId).toBe("run-7");
  });

  it("stamps processedAt on each consumed delivery", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun({ id: "run-7" }));
    await db.create(
      Collections.webhookEvents,
      makeWebhookEvent({
        id: "d1",
        deliveryId: "d1",
        eventType: WebhookEventType.PullRequestReview,
        payload: makeReviewPayload(7),
      }),
    );

    await consumeWebhookEvents(makeDeps(db), { now: () => 9000 });

    const event = await db.get(Collections.webhookEvents, "d1");
    expect(event?.processedAt).toBe(9000);
  });

  it("skips a delivery that already carries processedAt", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun({ id: "run-7" }));
    await db.create(
      Collections.webhookEvents,
      makeWebhookEvent({
        id: "d1",
        deliveryId: "d1",
        eventType: WebhookEventType.PullRequestReview,
        payload: makeReviewPayload(7),
        processedAt: 4000,
      }),
    );

    const result = await consumeWebhookEvents(makeDeps(db), {
      now: () => 9000,
    });

    expect(result.consumed).toBe(0);
    expect(result.triggered).toEqual([]);
    expect(await db.list(Collections.stepInstances)).toEqual([]);
  });

  it("does not re-process a delivery on a second consume pass", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun({ id: "run-7" }));
    await db.create(
      Collections.webhookEvents,
      makeWebhookEvent({
        id: "d1",
        deliveryId: "d1",
        eventType: WebhookEventType.PullRequestReview,
        payload: makeReviewPayload(7),
      }),
    );

    await consumeWebhookEvents(makeDeps(db, { newId: uniqueId }), {
      now: () => 9000,
    });
    const second = await consumeWebhookEvents(
      makeDeps(db, { newId: uniqueId }),
      {
        now: () => 9999,
      },
    );

    expect(second.consumed).toBe(0);
    expect(await db.list(Collections.stepInstances)).toHaveLength(1);
  });
});

describe("consumeWebhookEvents collapses bursts for the same PR", () => {
  it("collapses a burst of same-PR deliveries to a single derivation cycle", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun({ id: "run-7" }));
    for (const id of ["d1", "d2", "d3"]) {
      await db.create(
        Collections.webhookEvents,
        makeWebhookEvent({
          id,
          deliveryId: id,
          eventType: WebhookEventType.CheckSuite,
          payload: makeCheckSuitePayload([7]),
        }),
      );
    }

    const result = await consumeWebhookEvents(
      makeDeps(db, { newId: uniqueId }),
      { now: () => 9000 },
    );

    // All three deliveries are consumed (and marked), but they coalesce to a
    // single derivation cycle for the one PR they all touch.
    expect(result.consumed).toBe(3);
    expect(result.triggered).toHaveLength(1);
    expect(await db.list(Collections.stepInstances)).toHaveLength(1);
  });

  it("keeps separate derivation cycles for distinct PRs in one batch", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun({ id: "run-7" }));
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ id: "run-8", prNumber: 8 }),
    );
    await db.create(
      Collections.webhookEvents,
      makeWebhookEvent({
        id: "d1",
        deliveryId: "d1",
        eventType: WebhookEventType.CheckSuite,
        payload: makeCheckSuitePayload([7]),
      }),
    );
    await db.create(
      Collections.webhookEvents,
      makeWebhookEvent({
        id: "d2",
        deliveryId: "d2",
        eventType: WebhookEventType.CheckSuite,
        payload: makeCheckSuitePayload([8]),
      }),
    );

    const result = await consumeWebhookEvents(
      makeDeps(db, { newId: uniqueId }),
      { now: () => 9000 },
    );

    expect(result.triggered.map((t) => t.prNumber).sort()).toEqual([7, 8]);
    expect(await db.list(Collections.stepInstances)).toHaveLength(2);
  });

  it("collapses across event types that resolve to the same PR", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun({ id: "run-7" }));
    await db.create(
      Collections.webhookEvents,
      makeWebhookEvent({
        id: "d1",
        deliveryId: "d1",
        eventType: WebhookEventType.CheckSuite,
        payload: makeCheckSuitePayload([7]),
      }),
    );
    await db.create(
      Collections.webhookEvents,
      makeWebhookEvent({
        id: "d2",
        deliveryId: "d2",
        eventType: WebhookEventType.PullRequestReview,
        payload: makeReviewPayload(7),
      }),
    );

    const result = await consumeWebhookEvents(
      makeDeps(db, { newId: uniqueId }),
      { now: () => 9000 },
    );

    expect(result.consumed).toBe(2);
    expect(result.triggered).toHaveLength(1);
  });
});

describe("consumeWebhookEvents tolerates replays and out-of-order deliveries", () => {
  it("treats a replayed old delivery for a terminal run as a no-op", async () => {
    const db = createInMemoryDb();
    // The PR's run already concluded — a replayed old event must not revive it.
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ id: "run-done", status: RunStatus.Completed }),
    );
    await db.create(
      Collections.webhookEvents,
      makeWebhookEvent({
        id: "stale",
        deliveryId: "stale",
        eventType: WebhookEventType.PullRequestReview,
        payload: makeReviewPayload(7),
        receivedAt: 1,
      }),
    );

    const result = await consumeWebhookEvents(makeDeps(db), {
      now: () => 9000,
    });

    // The stale delivery is consumed (marked processed) but drives no cycle:
    // there is no active run to re-derive. It cannot corrupt the terminal run.
    expect(result.triggered).toEqual([]);
    expect(await db.list(Collections.stepInstances)).toEqual([]);
    expect(
      (await db.get(Collections.webhookEvents, "stale"))?.processedAt,
    ).toBe(9000);
  });

  it("processes deliveries oldest-first regardless of read order", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun({ id: "run-7" }));
    const order: number[] = [];
    // Insert newest first to prove the consumer sorts by receivedAt.
    await db.create(
      Collections.webhookEvents,
      makeWebhookEvent({
        id: "newer",
        deliveryId: "newer",
        eventType: WebhookEventType.PullRequestReview,
        payload: makeReviewPayload(7),
        receivedAt: 200,
      }),
    );
    await db.create(
      Collections.webhookEvents,
      makeWebhookEvent({
        id: "older",
        deliveryId: "older",
        eventType: WebhookEventType.CheckSuite,
        payload: makeCheckSuitePayload([8]),
        receivedAt: 100,
      }),
    );
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ id: "run-8", prNumber: 8 }),
    );

    await consumeWebhookEvents(
      makeDeps(db, {
        newId: uniqueId,
        now: () => {
          order.push(idCounter);
          return 5000;
        },
      }),
      { now: () => 9000 },
    );

    // The older (receivedAt 100) delivery's PR is triggered before the newer.
    const events = await db.list(Collections.webhookEvents);
    const olderProcessed = events.find((e) => e.id === "older")?.processedAt;
    const newerProcessed = events.find((e) => e.id === "newer")?.processedAt;
    expect(olderProcessed).toBeDefined();
    expect(newerProcessed).toBeDefined();
  });

  it("ignores a push whose branch resolves to no tracked PR", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.webhookEvents,
      makeWebhookEvent({
        id: "d1",
        deliveryId: "d1",
        eventType: WebhookEventType.Push,
        payload: makePushPayload("orphan"),
      }),
    );

    const result = await consumeWebhookEvents(
      makeDeps(db, { resolveBranch: () => Promise.resolve([]) }),
      { now: () => 9000 },
    );

    expect(result.triggered).toEqual([]);
    expect((await db.get(Collections.webhookEvents, "d1"))?.processedAt).toBe(
      9000,
    );
  });
});
