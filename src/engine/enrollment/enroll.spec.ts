import { describe, expect, it } from "vitest";
import { Collections, createDb } from "@/db";
import { DbAdapterKind, RunStatus, StepStatus } from "@/db";
import type { Db } from "@/db/types";
import { enrollPr } from "./enroll";
import {
  makeDiscoveredPr,
  makeWorkflowGraph,
} from "./enrollment-tests/fixtures";

// ---------------------------------------------------------------------------
// Tests for `enrollPr` — idempotent run enrollment (vision §5, §8.3; #126).
// Enrollment creates a `workflowRun` + first `stepInstance` from the loaded
// definition (version pinned), and refuses to re-enroll a PR that already has
// a non-terminal run for the same workflow (keyed on repo + prNumber +
// workflowId).
// ---------------------------------------------------------------------------

function freshDb(): Db {
  return createDb({ adapter: DbAdapterKind.InMemory });
}

// Deterministic id factory + clock so assertions target produced values.
function sequencedIds(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe("enrollment creates a run + first step with the version pinned", () => {
  it("creates a pending run pinned to the graph version with the matched workflowId", async () => {
    const db = freshDb();
    const pr = makeDiscoveredPr({ number: 42, title: "Bump lodash" });
    const graph = makeWorkflowGraph({ id: "dependabot-pr", version: 9 });

    const result = await enrollPr(db, pr, graph, {
      newId: sequencedIds(),
      now: () => 1000,
    });

    expect(result.created).toBe(true);
    const run = await db.get(Collections.workflowRuns, result.runId);
    expect(run?.workflowId).toBe("dependabot-pr");
    expect(run?.workflowVersion).toBe(9);
    expect(run?.prNumber).toBe(42);
    expect(run?.prTitle).toBe("Bump lodash");
    expect(run?.status).toBe(RunStatus.Pending);
  });

  it("seeds the first step from the graph's first step definition", async () => {
    const db = freshDb();
    const graph = makeWorkflowGraph({
      steps: [
        {
          id: "open-review",
          stepType: makeWorkflowGraph().steps[0]!.stepType,
          input: { skill: "review" },
          routing: [{ condition: "output.ok", next: undefined }],
        },
      ],
    });

    const result = await enrollPr(db, makeDiscoveredPr(), graph, {
      newId: sequencedIds(),
      now: () => 1000,
    });

    const steps = await db.list(Collections.stepInstances, {
      runId: result.runId,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.stepDefinitionId).toBe("open-review");
    expect(steps[0]?.input).toEqual({ skill: "review" });
    expect(steps[0]?.status).toBe(StepStatus.Pending);
  });
});

describe("idempotency guard: a PR with an active run is not re-enrolled", () => {
  it("returns the existing run id and creates no second run on re-enrollment", async () => {
    const db = freshDb();
    const pr = makeDiscoveredPr({ number: 5 });
    const graph = makeWorkflowGraph({ id: "base-pr" });

    const first = await enrollPr(db, pr, graph, { newId: sequencedIds() });
    const second = await enrollPr(db, pr, graph, { newId: sequencedIds() });

    expect(second.created).toBe(false);
    expect(second.runId).toBe(first.runId);
    const runs = await db.list(Collections.workflowRuns, {
      repo: pr.repo,
      prNumber: pr.number,
    });
    expect(runs).toHaveLength(1);
  });

  it("re-enrolls when the prior run for the workflow is terminal", async () => {
    const db = freshDb();
    const pr = makeDiscoveredPr({ number: 5 });
    const graph = makeWorkflowGraph({ id: "base-pr" });
    const newId = sequencedIds();

    const first = await enrollPr(db, pr, graph, { newId });
    await db.update(Collections.workflowRuns, first.runId, {
      status: RunStatus.Completed,
    });
    const second = await enrollPr(db, pr, graph, { newId });

    expect(second.created).toBe(true);
    expect(second.runId).not.toBe(first.runId);
  });

  it("enrolls separately for a different workflow on the same PR", async () => {
    const db = freshDb();
    const pr = makeDiscoveredPr({ number: 5 });
    const newId = sequencedIds();

    const base = await enrollPr(db, pr, makeWorkflowGraph({ id: "base-pr" }), {
      newId,
    });
    const security = await enrollPr(
      db,
      pr,
      makeWorkflowGraph({ id: "security-pr" }),
      { newId },
    );

    expect(security.created).toBe(true);
    expect(security.runId).not.toBe(base.runId);
  });
});
