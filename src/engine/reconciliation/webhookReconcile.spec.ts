import { describe, expect, it } from "vitest";
import type { Config, WorkflowGraph } from "@/config";
import { createDb, DbAdapterKind } from "@/db";
import { Collections } from "@/db/collections";
import { StepStatus, StepType, type WorkflowRun } from "@/db/schemas";
import type { Db } from "@/db/types";
import type { DiscoveredPr, PrReadTransport } from "@/engine/discovery";
import {
  makeConfig,
  makeRepositoryConfig,
  makeWorkflowGraph,
} from "@/engine/enrollment/enrollment-tests/fixtures";
import {
  makePullRequestPayload,
  makeWebhookEvent,
  makeWorkflowRun,
  TEST_REPO,
} from "@/engine/webhook/webhook-tests/fixtures";
import { createRateLimiter } from "./backpressure";
import { reconcileWebhookEvents, SkipReason } from "./webhookReconcile";

// ---------------------------------------------------------------------------
// Polling reconciliation fallback (#114). These tests cover the two acceptance
// criteria with behaviour of their own: the reconciliation *catch* (a PR whose
// webhook-driven trigger was missed is still re-derived on the next pass) and
// the *backpressure limit* (an event storm cannot enqueue an unbounded burst of
// derivations). The self-discovery sweep is exercised at the smoke level only —
// its enrolment edge cases are owned by the self-discovery spec.
// ---------------------------------------------------------------------------

function freshDb(): Db {
  return createDb({ adapter: DbAdapterKind.InMemory });
}

// A transport that lists no open PRs by default, so self-discovery is a no-op
// unless a test scripts PRs for it. Filters to the requested repo.
function transportReturning(prs: DiscoveredPr[]): PrReadTransport {
  return {
    listOpenPrs: (repoId) =>
      Promise.resolve(prs.filter((pr) => pr.repo === repoId)),
  };
}

function resolverFor(
  graphs: WorkflowGraph[],
): (id: string) => WorkflowGraph | undefined {
  const byId = new Map(graphs.map((g) => [g.id, g]));
  return (id) => byId.get(id);
}

// Config + self-discovery options whose sweep returns the supplied PRs. A
// generous rate limiter (capacity high enough not to throttle) is the default;
// the backpressure test overrides it with a tight one.
function reconcileFor(
  db: Db,
  options: { openPrs?: DiscoveredPr[]; lookbackMs?: number } = {},
) {
  const config: Config = makeConfig([
    makeRepositoryConfig({
      id: TEST_REPO,
      workflows: [{ match: "*", workflowId: "base-pr" }],
    }),
  ]);
  return {
    db,
    config,
    rateLimiter: createRateLimiter({
      capacity: 100,
      refillTokens: 100,
      refillIntervalMs: 1000,
    }),
    selfDiscovery: {
      transport: transportReturning(options.openPrs ?? []),
      resolveWorkflow: resolverFor([makeWorkflowGraph({ id: "base-pr" })]),
    },
    lookbackMs: options.lookbackMs,
    now: () => 10_000,
  };
}

async function seedTrackedRun(
  db: Db,
  overrides: Partial<WorkflowRun> = {},
): Promise<WorkflowRun> {
  const run = makeWorkflowRun(overrides);
  await db.create(Collections.workflowRuns, run);
  return run;
}

describe("reconciliation catch: re-derives a PR whose webhook trigger was missed", () => {
  it("enqueues a derive_pr_state step for a tracked PR with a stored-but-unprocessed delivery", async () => {
    const db = freshDb();
    // A tracked, active run exists for TEST_REPO#7, but no derivation step was
    // ever created — the listener dropped the delivery. The raw delivery is
    // still persisted in webhookEvents (the receiver always persists first).
    const run = await seedTrackedRun(db, { id: "run-7", prNumber: 7 });
    await db.create(
      Collections.webhookEvents,
      makeWebhookEvent({
        id: "missed-1",
        deliveryId: "missed-1",
        payload: makePullRequestPayload(7),
        receivedAt: 9000,
      }),
    );

    const report = await reconcileWebhookEvents(reconcileFor(db));

    expect(report.retriggered).toEqual(["missed-1"]);
    const steps = await db.list(Collections.stepInstances, { runId: run.id });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.stepDefinitionId).toBe("derive_pr_state");
    expect(steps[0]?.stepType).toBe(StepType.DerivePrState);
    expect(steps[0]?.status).toBe(StepStatus.Pending);
  });

  it("skips deliveries older than the lookback window", async () => {
    const db = freshDb();
    await seedTrackedRun(db, { id: "run-7", prNumber: 7 });
    await db.create(
      Collections.webhookEvents,
      makeWebhookEvent({
        id: "stale-1",
        deliveryId: "stale-1",
        payload: makePullRequestPayload(7),
        receivedAt: 1000, // now=10_000, lookback=2_000 ⇒ cutoff=8_000
      }),
    );

    const report = await reconcileWebhookEvents(
      reconcileFor(db, { lookbackMs: 2000 }),
    );

    expect(report.retriggered).toEqual([]);
    const steps = await db.list(Collections.stepInstances);
    expect(steps).toHaveLength(0);
  });
});

describe("backpressure: an event storm is rate-limited", () => {
  it("re-triggers only up to the bucket capacity and defers the rest", async () => {
    const db = freshDb();
    await seedTrackedRun(db, { id: "run-7", prNumber: 7 });
    // Five stored deliveries for the same tracked PR arrive in a burst.
    for (let i = 0; i < 5; i += 1) {
      await db.create(
        Collections.webhookEvents,
        makeWebhookEvent({
          id: `storm-${String(i)}`,
          deliveryId: `storm-${String(i)}`,
          payload: makePullRequestPayload(7),
          receivedAt: 9000 + i,
        }),
      );
    }

    const deps = reconcileFor(db);
    // A tight bucket: only two re-triggers admitted this pass, no refill within.
    deps.rateLimiter = createRateLimiter({
      capacity: 2,
      refillTokens: 1,
      refillIntervalMs: 1_000_000,
      now: () => 0,
    });

    const report = await reconcileWebhookEvents(deps);

    expect(report.retriggered).toHaveLength(2);
    // The deferred deliveries are the later (higher receivedAt) ones, since the
    // pass processes oldest-first, each tagged with the backpressure reason.
    expect(report.skipped).toEqual([
      { deliveryId: "storm-2", reason: SkipReason.RateLimited },
      { deliveryId: "storm-3", reason: SkipReason.RateLimited },
      { deliveryId: "storm-4", reason: SkipReason.RateLimited },
    ]);
    expect(report.retriggered).toEqual(["storm-0", "storm-1"]);
  });
});

describe("self-discovery net: enrolls an untracked PR the event path missed", () => {
  it("creates a run for an open PR with no stored delivery and no existing run", async () => {
    const db = freshDb();
    const report = await reconcileWebhookEvents(
      reconcileFor(db, {
        openPrs: [
          { repo: TEST_REPO, number: 99, author: "octocat", title: "x" },
        ],
      }),
    );

    expect(report.discovery.enrolled).toHaveLength(1);
    expect(report.discovery.enrolled[0]?.created).toBe(true);
    const runs = await db.list(Collections.workflowRuns, { prNumber: 99 });
    expect(runs).toHaveLength(1);
  });
});
