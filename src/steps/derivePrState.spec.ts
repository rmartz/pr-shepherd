import { describe, it, expect, vi } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import {
  RunStatus,
  StepStatus,
  StepType,
  type StepInstance,
  type WorkflowRun,
} from "@/db/schemas";
import type { Db } from "@/db/types";
import {
  CIState,
  ReviewState,
  type GithubReadTransport,
} from "@/engine/derivation";
import { createRunner } from "@/engine/runner";
import { makeNoopRuntime } from "@/engine/runner/runner-tests/fixtures";
import { createDerivePrStateExecutor } from "./derivePrState";

// ---------------------------------------------------------------------------
// Tests for the derive_pr_state step executor.
//
// The executor reads the run's repo + PR, fetches one snapshot through an
// injected read transport (no real HTTP, mirroring snapshot.spec.ts), derives
// the 8-axis vector, and returns `{ state }`. The smoke tests below assert it
// wires fetch → derive → output correctly and that the runner lands the vector
// at `context.state`. The axis-by-axis correctness is covered by the
// derivation's own tests (#96); these do not re-test it.
// ---------------------------------------------------------------------------

// A snapshot whose interpretation is deliberately NON-default on two axes: a
// real Actions FAILURE (→ ci: failing, not the empty-default passed) and an
// APPROVED review covering HEAD (→ review: approved). That proves the executor
// actually ran derivation rather than returning an initializer vector.
function graphqlResponse(): unknown {
  return {
    repository: {
      pullRequest: {
        number: 42,
        title: "Add a thing",
        isDraft: false,
        mergeable: "MERGEABLE",
        baseRefName: "main",
        headRefName: "feat/thing",
        author: { login: "rmartz" },
        labels: { nodes: [] },
        commits: { nodes: [{ commit: { oid: "oid-head" } }] },
        headCommit: {
          nodes: [
            {
              commit: {
                oid: "oid-head",
                checkSuites: {
                  nodes: [
                    {
                      app: { name: "GitHub Actions" },
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                      workflowRun: { workflow: { name: "CI" } },
                    },
                  ],
                },
                status: { contexts: [] },
              },
            },
          ],
        },
        reviewThreads: { nodes: [] },
      },
    },
  };
}

const REST_REVIEWS = [
  {
    id: 1001,
    user: { login: "reviewer" },
    state: "APPROVED",
    submitted_at: "2026-06-01T00:00:00Z",
    commit_id: "oid-head",
    body: "lgtm",
  },
];

function makeTransport(): GithubReadTransport & {
  graphql: ReturnType<typeof vi.fn>;
  restPaginate: ReturnType<typeof vi.fn>;
} {
  const graphql = vi.fn(
    (): Promise<unknown> => Promise.resolve(graphqlResponse()),
  );
  const restPaginate = vi.fn(
    (path: string): Promise<unknown[]> =>
      Promise.resolve(path.includes("/reviews") ? REST_REVIEWS : []),
  );
  return { graphql, restPaginate } as never;
}

function makeWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: "rmartz/pr-shepherd",
    prNumber: 42,
    prTitle: "test pr",
    status: RunStatus.Running,
    childRunIds: [],
    context: {},
    createdAt: 1000,
    updatedAt: 1000,
    metrics: {
      totalClaudeMs: 0,
      totalActiveMs: 0,
      totalScheduleWaitMs: 0,
      totalExternalWaitMs: 0,
    },
    ...overrides,
  };
}

async function seedRun(
  db: Db,
  overrides: Partial<WorkflowRun> = {},
): Promise<WorkflowRun> {
  const run = makeWorkflowRun(overrides);
  await db.create(Collections.workflowRuns, run);
  return run;
}

async function seedStep(
  db: Db,
  overrides: Partial<StepInstance> = {},
): Promise<StepInstance> {
  const step: StepInstance = {
    id: "step-1",
    runId: "run-1",
    stepDefinitionId: "derive",
    stepType: StepType.DerivePrState,
    status: StepStatus.Running,
    input: {},
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1000,
    startedAt: 1100,
    metrics: {
      claudeMs: 0,
      activeMs: 0,
      scheduleWaitMs: 0,
      externalWaitMs: 0,
    },
    ...overrides,
  };
  await db.create(Collections.stepInstances, step);
  return step;
}

describe("createDerivePrStateExecutor returns the derived axis vector as output.state", () => {
  it("fetches the run's PR, derives, and returns the vector", async () => {
    const db = createInMemoryDb();
    await seedRun(db);
    const step = await seedStep(db);
    const transport = makeTransport();

    const executor = createDerivePrStateExecutor({ db, transport });
    const result = await executor(step, makeNoopRuntime());

    expect(result.output["state"]).toMatchObject({
      ci: CIState.Failing,
      review: ReviewState.Approved,
    });
  });

  it("targets the run's owner/repo + PR number on the snapshot fetch", async () => {
    const db = createInMemoryDb();
    await seedRun(db, { repo: "rmartz/pr-shepherd", prNumber: 99 });
    const step = await seedStep(db);
    const transport = makeTransport();

    await createDerivePrStateExecutor({ db, transport })(
      step,
      makeNoopRuntime(),
    );

    expect(transport.graphql).toHaveBeenCalledWith(expect.any(String), {
      owner: "rmartz",
      name: "pr-shepherd",
      number: 99,
    });
  });
});

describe("the runner merges the vector into context.state", () => {
  it("makes the derived vector readable at workflowRun.context.state after dispatch", async () => {
    const db = createInMemoryDb();
    await seedRun(db);
    const step = await seedStep(db);
    const transport = makeTransport();

    const runner = createRunner(db);
    runner.register(
      StepType.DerivePrState,
      createDerivePrStateExecutor({ db, transport }),
    );
    await runner.dispatch(step);

    const run = await db.get(Collections.workflowRuns, "run-1");
    expect(run?.context["state"]).toMatchObject({ ci: CIState.Failing });
  });
});

describe("createDerivePrStateExecutor is read-only", () => {
  it("performs no GitHub mutation — only the read transport's read methods are used", async () => {
    const db = createInMemoryDb();
    await seedRun(db);
    const step = await seedStep(db);
    const transport = makeTransport();

    await createDerivePrStateExecutor({ db, transport })(
      step,
      makeNoopRuntime(),
    );

    // The injected transport exposes only `graphql` + `restPaginate` (reads).
    // restPaginate is called for reviews/comments; no write-shaped call exists.
    expect(transport.graphql).toHaveBeenCalledTimes(1);
    const restPaths = transport.restPaginate.mock.calls.map(
      (c) => c[0] as string,
    );
    expect(restPaths.every((p) => p.startsWith("/repos/"))).toBe(true);
  });
});

describe("createDerivePrStateExecutor surfaces a missing run", () => {
  it("throws when the step references a runId that does not exist", async () => {
    const db = createInMemoryDb();
    const step = await seedStep(db, { runId: "ghost-run" });
    const transport = makeTransport();

    await expect(
      createDerivePrStateExecutor({ db, transport })(step, makeNoopRuntime()),
    ).rejects.toThrow("ghost-run");
  });
});
