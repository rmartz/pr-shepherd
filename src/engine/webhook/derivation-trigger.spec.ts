import { describe, it, expect } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import {
  RunStatus,
  StepStatus,
  StepType,
  WebhookEventType,
} from "@/db/schemas";
import {
  DropReason,
  triggerDerivations,
  type TriggerDerivationsDependencies,
} from "./derivation-trigger";
import {
  makeCheckSuitePayload,
  makePushPayload,
  makeReviewPayload,
  makeWebhookEvent,
  makeWorkflowRun,
  TEST_REPO,
} from "./webhook-tests/fixtures";

// ---------------------------------------------------------------------------
// `triggerDerivations` maps a persisted webhook delivery to a re-derivation of
// each affected tracked PR. These tests assert:
//   - representative payloads (check_suite / pull_request_review / push)
//     enqueue a derivation cycle for the right PR (#112 criteria 1, 4);
//   - events touching no tracked PR drop cleanly as a no-op (#112 criterion 2);
//   - the enqueued cycle re-seeds the lifecycle's `derive_pr_state` head with
//     no run/lifecycle mutation — a trigger swap only (#112 criterion 3).
// ---------------------------------------------------------------------------

function makeDeps(
  overrides: Partial<TriggerDerivationsDependencies> = {},
): TriggerDerivationsDependencies {
  return {
    db: createInMemoryDb(),
    now: () => 5000,
    newId: () => "step-new",
    ...overrides,
  };
}

describe("triggerDerivations enqueues a derivation cycle for the affected PR", () => {
  it("enqueues a derivation for the PR a check_suite completion names", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ id: "run-42", prNumber: 42 }),
    );
    const event = makeWebhookEvent({
      eventType: WebhookEventType.CheckSuite,
      payload: makeCheckSuitePayload([42]),
    });

    const result = await triggerDerivations(event, makeDeps({ db }));

    expect(result.dropped).toBeUndefined();
    expect(result.triggered).toEqual([
      {
        runId: "run-42",
        stepInstanceId: "step-new",
        repo: TEST_REPO,
        prNumber: 42,
      },
    ]);
  });

  it("enqueues a derivation for the PR a pull_request_review names", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ id: "run-13", prNumber: 13 }),
    );
    const event = makeWebhookEvent({
      eventType: WebhookEventType.PullRequestReview,
      payload: makeReviewPayload(13),
    });

    const result = await triggerDerivations(event, makeDeps({ db }));

    expect(result.triggered.map((t) => t.runId)).toEqual(["run-13"]);
  });

  it("resolves a push branch to its PR and enqueues that derivation", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ id: "run-8", prNumber: 8 }),
    );
    const event = makeWebhookEvent({
      eventType: WebhookEventType.Push,
      payload: makePushPayload("feat/widget"),
    });

    const result = await triggerDerivations(
      event,
      makeDeps({ db, resolveBranch: () => Promise.resolve([8]) }),
    );

    expect(result.triggered.map((t) => t.prNumber)).toEqual([8]);
  });
});

describe("triggerDerivations drops events touching no tracked PR", () => {
  it("drops an event whose PR has no active run", async () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.CheckSuite,
      payload: makeCheckSuitePayload([99]),
    });

    const result = await triggerDerivations(event, makeDeps());

    expect(result.triggered).toEqual([]);
    expect(result.dropped).toBe(DropReason.Untracked);
  });

  it("drops an event for a PR whose only run is terminal", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ id: "run-done", status: RunStatus.Completed }),
    );
    const event = makeWebhookEvent({
      eventType: WebhookEventType.PullRequestReview,
      payload: makeReviewPayload(7),
    });

    const result = await triggerDerivations(event, makeDeps({ db }));

    expect(result.dropped).toBe(DropReason.Untracked);
    expect(await db.list(Collections.stepInstances)).toEqual([]);
  });

  it("drops a push whose branch resolves to no tracked PR", async () => {
    const event = makeWebhookEvent({
      eventType: WebhookEventType.Push,
      payload: makePushPayload("orphan"),
    });

    const result = await triggerDerivations(
      event,
      makeDeps({ resolveBranch: () => Promise.resolve([]) }),
    );

    // The push named a branch (a target) but it maps to no active run.
    expect(result.dropped).toBe(DropReason.Untracked);
  });
});

describe("triggerDerivations re-seeds the derive_pr_state lifecycle head", () => {
  it("creates a pending derive_pr_state step against the tracked run", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun({ id: "run-7" }));
    const event = makeWebhookEvent({
      eventType: WebhookEventType.PullRequestReview,
      payload: makeReviewPayload(7),
    });

    await triggerDerivations(event, makeDeps({ db }));

    const step = await db.get(Collections.stepInstances, "step-new");
    expect(step?.runId).toBe("run-7");
    expect(step?.stepDefinitionId).toBe("derive_pr_state");
    expect(step?.stepType).toBe(StepType.DerivePrState);
    expect(step?.status).toBe(StepStatus.Pending);
  });

  it("does not mutate the tracked run (trigger swap only)", async () => {
    const db = createInMemoryDb();
    const run = makeWorkflowRun({ id: "run-7", status: RunStatus.Running });
    await db.create(Collections.workflowRuns, run);
    const event = makeWebhookEvent({
      eventType: WebhookEventType.PullRequestReview,
      payload: makeReviewPayload(7),
    });

    await triggerDerivations(event, makeDeps({ db }));

    expect(await db.get(Collections.workflowRuns, "run-7")).toEqual(run);
  });

  it("enqueues one cycle per run when many targets resolve to the same run", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun({ id: "run-7" }));
    const event = makeWebhookEvent({
      eventType: WebhookEventType.CheckSuite,
      payload: makeCheckSuitePayload([7, 7]),
    });

    const result = await triggerDerivations(event, makeDeps({ db }));

    expect(result.triggered).toHaveLength(1);
    expect(await db.list(Collections.stepInstances)).toHaveLength(1);
  });
});
