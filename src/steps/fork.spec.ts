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
import { createForkExecutor, type FirstStepSpec } from "./fork";

// ---------------------------------------------------------------------------
// Tests for the `fork` step executor (vision §4.3, §5.2).
//
// `fork` creates a child workflowRun and its first stepInstance linked to
// the parent via `workflowRun.parentRunId` and the parent's `childRunIds`.
// It enforces a configurable depth cap (default 5) — at the cap the step
// fails with a descriptive chain message so operators can identify the
// runaway lineage. Zero-cost admission is enforced upstream by #45.
// ---------------------------------------------------------------------------

function makeWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    workflowId: "base-pr",
    workflowVersion: 1,
    repo: "owner/repo-a",
    prNumber: 1,
    prTitle: "parent",
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

function makeForkStep(overrides: Partial<StepInstance> = {}): StepInstance {
  return {
    id: "step-fork",
    runId: "run-1",
    stepDefinitionId: "spawn_fix_pr",
    stepType: StepType.Fork,
    status: StepStatus.Running,
    input: {
      workflowId: "dependabot-fix",
      prNumber: 42,
      initialContext: {},
    },
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1100,
    metrics: {
      claudeMs: 0,
      activeMs: 0,
      scheduleWaitMs: 0,
      externalWaitMs: 0,
    },
    ...overrides,
  };
}

const FIRST_STEP: FirstStepSpec = {
  stepDefinitionId: "load_pr_context",
  stepType: StepType.GithubApi,
  input: { kind: "load_pr_context" },
};

function makeFirstStepFactory(spec: FirstStepSpec = FIRST_STEP) {
  return vi.fn<(workflowId: string) => Promise<FirstStepSpec>>(() =>
    Promise.resolve(spec),
  );
}

// Helper that seeds a chain of exactly `chainLength` runs ending at
// `leafId`. The fork step belongs to `leafId`; its would-be child has
// depth `chainLength` (child.depth = chain.length).
async function seedRunChain(
  db: Db,
  chainLength: number,
  leafId: string,
): Promise<void> {
  let parentRunId: string | undefined;
  for (let i = 0; i < chainLength; i++) {
    const id = i === chainLength - 1 ? leafId : `chain-${i.toString()}`;
    const run = makeWorkflowRun({
      id,
      parentRunId,
      childRunIds: [],
    });
    await db.create(Collections.workflowRuns, run);
    parentRunId = id;
  }
}

describe("forkExecutor creates a child workflowRun and first stepInstance", () => {
  it("returns the new child id and links it to the parent's childRunIds", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun({ id: "run-1" }));
    const firstStepFactory = makeFirstStepFactory();
    let nextId = 0;
    const exec = createForkExecutor(db, {
      firstStepFactory,
      newId: () => `gen-${(nextId++).toString()}`,
    });
    const result = await exec(makeForkStep({ runId: "run-1" }));
    expect(result.output).toEqual({ childRunId: "gen-0" });
    const childRun = await db.get(Collections.workflowRuns, "gen-0");
    expect(childRun?.parentRunId).toBe("run-1");
    expect(childRun?.workflowId).toBe("dependabot-fix");
    expect(childRun?.prNumber).toBe(42);
    expect(childRun?.status).toBe(RunStatus.Pending);
    const parent = await db.get(Collections.workflowRuns, "run-1");
    expect(parent?.childRunIds).toEqual(["gen-0"]);
  });
});

describe("forkExecutor seeds the child's first stepInstance via the injected factory", () => {
  it("creates a pending stepInstance using the factory's spec", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun({ id: "run-1" }));
    const firstStepFactory = makeFirstStepFactory({
      stepDefinitionId: "boot",
      stepType: StepType.ClaudeSkill,
      input: { skill: "boot-up" },
    });
    let nextId = 0;
    const exec = createForkExecutor(db, {
      firstStepFactory,
      newId: () => `gen-${(nextId++).toString()}`,
    });
    await exec(makeForkStep({ runId: "run-1" }));
    expect(firstStepFactory).toHaveBeenCalledWith("dependabot-fix");
    const childSteps = await db.list(Collections.stepInstances, {
      runId: "gen-0",
    });
    expect(childSteps).toHaveLength(1);
    expect(childSteps[0]?.stepDefinitionId).toBe("boot");
    expect(childSteps[0]?.stepType).toBe(StepType.ClaudeSkill);
    expect(childSteps[0]?.status).toBe(StepStatus.Pending);
    expect(childSteps[0]?.input).toEqual({ skill: "boot-up" });
  });
});

describe("forkExecutor inherits the parent run's repo onto the child run", () => {
  it("copies parent.repo onto the child run", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ id: "run-1", repo: "owner/special-repo" }),
    );
    let nextId = 0;
    const exec = createForkExecutor(db, {
      firstStepFactory: makeFirstStepFactory(),
      newId: () => `gen-${(nextId++).toString()}`,
    });
    await exec(makeForkStep({ runId: "run-1" }));
    const childRun = await db.get(Collections.workflowRuns, "gen-0");
    expect(childRun?.repo).toBe("owner/special-repo");
  });
});

describe("forkExecutor at the default cap throws with a descriptive chain", () => {
  it("rejects with every parent chain identifier in the error message", async () => {
    const db = createInMemoryDb();
    // Chain of length 5 (chain-0 → chain-1 → chain-2 → chain-3 → leaf);
    // the fork step's would-be child would be depth 5 = the default cap,
    // which is the first depth that fails (cap is exclusive).
    await seedRunChain(db, 5, "leaf");
    const exec = createForkExecutor(db, {
      firstStepFactory: makeFirstStepFactory(),
      newId: () => "should-not-be-created",
    });
    await expect(exec(makeForkStep({ runId: "leaf" }))).rejects.toThrow(
      /fork depth cap exceeded/i,
    );
    await expect(exec(makeForkStep({ runId: "leaf" }))).rejects.toThrow(
      /chain-0.*chain-1.*chain-2.*chain-3.*leaf/,
    );
  });
});

describe("forkExecutor one level below the default cap succeeds", () => {
  it("creates a child whose depth is cap - 1", async () => {
    const db = createInMemoryDb();
    // Chain of length 4 → would-be child has depth 4 < cap 5 (allowed).
    await seedRunChain(db, 4, "leaf");
    const exec = createForkExecutor(db, {
      firstStepFactory: makeFirstStepFactory(),
      newId: () => "child-leaf",
    });
    const result = await exec(makeForkStep({ runId: "leaf" }));
    expect(result.output).toEqual({ childRunId: "child-leaf" });
  });
});

describe("forkExecutor honours a custom maxDepth", () => {
  it("applies the configured cap rather than the default", async () => {
    const db = createInMemoryDb();
    // Chain of length 2 → would-be child depth 2 = custom cap → fail.
    await seedRunChain(db, 2, "leaf");
    const exec = createForkExecutor(db, {
      firstStepFactory: makeFirstStepFactory(),
      newId: () => "blocked",
      maxDepth: 2,
    });
    await expect(exec(makeForkStep({ runId: "leaf" }))).rejects.toThrow(
      /fork depth cap exceeded/i,
    );
  });
});

describe("forkExecutor initialContext from input populates child context", () => {
  it("writes the provided initialContext onto the child run", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.workflowRuns, makeWorkflowRun({ id: "run-1" }));
    let nextId = 0;
    const exec = createForkExecutor(db, {
      firstStepFactory: makeFirstStepFactory(),
      newId: () => `gen-${(nextId++).toString()}`,
    });
    await exec(
      makeForkStep({
        runId: "run-1",
        input: {
          workflowId: "dependabot-fix",
          prNumber: 7,
          initialContext: { seeded: "yes", count: 3 },
        },
      }),
    );
    const childRun = await db.get(Collections.workflowRuns, "gen-0");
    expect(childRun?.context).toEqual({ seeded: "yes", count: 3 });
  });
});

describe("createForkExecutor rejects a non-positive-integer maxDepth", () => {
  it("throws at construction time when maxDepth is 0", () => {
    const db = createInMemoryDb();
    expect(() =>
      createForkExecutor(db, {
        firstStepFactory: makeFirstStepFactory(),
        maxDepth: 0,
      }),
    ).toThrow(/positive integer/i);
  });
});

describe("forkExecutor throws when the chain contains a cycle", () => {
  it("rejects a parentRunId pointer that creates a loop", async () => {
    const db = createInMemoryDb();
    // run-a → run-b → run-a (cycle)
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ id: "run-a", parentRunId: "run-b" }),
    );
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ id: "run-b", parentRunId: "run-a" }),
    );
    const exec = createForkExecutor(db, {
      firstStepFactory: makeFirstStepFactory(),
      newId: () => "ignored",
    });
    await expect(exec(makeForkStep({ runId: "run-a" }))).rejects.toThrow(
      /cycle detected/i,
    );
  });
});

describe("forkExecutor throws when the chain references a missing parent run", () => {
  it("does not silently truncate the chain on a dangling parentRunId", async () => {
    const db = createInMemoryDb();
    // run-leaf points at a parent that doesn't exist — without the
    // missing-parent guard the chain would silently truncate to length
    // 1 and the cap could be bypassed.
    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ id: "run-leaf", parentRunId: "run-ghost" }),
    );
    const exec = createForkExecutor(db, {
      firstStepFactory: makeFirstStepFactory(),
      newId: () => "ignored",
    });
    await expect(exec(makeForkStep({ runId: "run-leaf" }))).rejects.toThrow(
      /missing parent run run-ghost/,
    );
  });
});
