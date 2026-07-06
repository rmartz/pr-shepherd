import { describe, it, expect, vi } from "vitest";
import { createInMemoryDb } from "@/db/adapters/inMemory";
import { Collections } from "@/db/collections";
import { StepStatus, StepType, type StepInstance } from "@/db/schemas";
import type { Db } from "@/db/types";
import type { GithubReadTransport } from "@/engine/derivation";
import type { GithubTransport } from "@/steps/githubApi";
import { assembleRunner, type AssembleRunnerDeps } from "./assembleRunner";

// A read transport whose methods are never actually reached in these tests
// (derive_pr_state fails at run-lookup before calling it), but must satisfy the
// interface.
const readTransport: GithubReadTransport = {
  graphql: <T>(): Promise<T> => Promise.resolve(undefined as T),
  restPaginate: <T>(): Promise<T[]> => Promise.resolve([] as T[]),
};

function baseDeps(db: Db, writeTransport: GithubTransport): AssembleRunnerDeps {
  return {
    db,
    readTransport,
    writeTransport,
    firstStepFactory: () =>
      Promise.resolve({
        stepDefinitionId: "first",
        stepType: StepType.Decision,
        input: {},
      }),
  };
}

function makeStep(
  stepType: StepType,
  input: Record<string, unknown>,
): StepInstance {
  return {
    id: `step-${stepType}`,
    runId: "run-x",
    stepDefinitionId: "d",
    stepType,
    status: StepStatus.Queued,
    input,
    output: {},
    logs: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: 1,
    metrics: { claudeMs: 0, activeMs: 0, scheduleWaitMs: 0, externalWaitMs: 0 },
  };
}

describe("assembleRunner registers an executor for every StepType", () => {
  it("dispatching any StepType never fails with 'no executor registered'", async () => {
    const db = createInMemoryDb();
    const runner = assembleRunner(
      baseDeps(db, { call: () => Promise.resolve({ kind: "ok", data: {} }) }),
    );

    // Each executor parses its input first, so an empty-input step fails at
    // validation (or, for derive_pr_state, at run-lookup) — never at the
    // executor-registry lookup. An unregistered StepType would instead fail
    // with "no executor registered for stepType …".
    for (const stepType of Object.values(StepType)) {
      const step = makeStep(stepType, {});
      await db.create(Collections.stepInstances, step);
      await runner.dispatch(step);
      const after = await db.get(Collections.stepInstances, step.id);
      expect(after?.error ?? "").not.toMatch(/no executor registered/);
    }
  });
});

describe("assembleRunner wires github_api to the write transport", () => {
  it("runs a github_api step's actions through the injected transport", async () => {
    const db = createInMemoryDb();
    const call = vi.fn(
      (): Promise<{ kind: "ok"; data: Record<string, unknown> }> =>
        Promise.resolve({ kind: "ok", data: {} }),
    );
    const runner = assembleRunner(baseDeps(db, { call }));
    const step = makeStep(StepType.GithubApi, {
      actions: [
        {
          type: "add_label",
          params: { repo: "o/r", pr: 7, label: "approved" },
        },
      ],
    });
    await db.create(Collections.stepInstances, step);

    await runner.dispatch(step);

    const after = await db.get(Collections.stepInstances, step.id);
    expect(after?.status).toBe(StepStatus.Completed);
    expect(call).toHaveBeenCalledOnce();
    const results = (after?.output["results"] ?? []) as { outcome: string }[];
    expect(results[0]?.outcome).toBe("ok");
  });
});
