import { describe, it, expect, beforeEach } from "vitest";
import { createHostedFirestoreDb } from "../hostedFirestore";
import { Collections } from "../../collections";
import { RunStatus, type Repository, type WorkflowRun } from "../../schemas";
import { listeners, makeFakeAdmin, makeFakeClient, makeRepo } from "./fixtures";

beforeEach(() => {
  listeners.clear();
});

// ---------------------------------------------------------------------------
// Acceptance Criterion 2: writes use firebase-admin.
// ---------------------------------------------------------------------------
describe("Writes go through the injected admin Firestore handle", () => {
  it("create() calls admin .doc(id).set(doc)", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    const repo = makeRepo({ id: "a/x", owner: "a" });
    await db.create(Collections.repositories, repo);
    expect(store.get("repositories")?.get(encodeURIComponent("a/x"))).toEqual(
      repo,
    );
  });

  it("update() merges patch into the existing admin doc", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    const repo = makeRepo({ concurrencyMax: 2 });
    await db.create(Collections.repositories, repo);
    await db.update(Collections.repositories, repo.id, { concurrencyMax: 7 });
    const stored = store
      .get("repositories")
      ?.get(encodeURIComponent(repo.id)) as Repository;
    expect(stored.concurrencyMax).toBe(7);
    expect(stored.owner).toBe(repo.owner);
  });

  it("delete() removes the doc from the admin collection", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    const repo = makeRepo();
    await db.create(Collections.repositories, repo);
    await db.delete(Collections.repositories, repo.id);
    expect(store.get("repositories")?.has(encodeURIComponent(repo.id))).toBe(
      false,
    );
  });

  it("strips undefined fields before persisting", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    const run: WorkflowRun = {
      id: "run/1",
      workflowId: "base-pr",
      workflowVersion: 1,
      repo: "rmartz/pr-shepherd",
      prNumber: 50,
      prTitle: "test",
      status: RunStatus.Pending,
      parentRunId: undefined,
      childRunIds: [],
      context: {},
      currentStepId: undefined,
      createdAt: 1,
      updatedAt: 1,
      completedAt: undefined,
      metrics: {
        totalClaudeMs: 0,
        totalActiveMs: 0,
        totalScheduleWaitMs: 0,
        totalExternalWaitMs: 0,
      },
    };
    await db.create(Collections.workflowRuns, run);
    const stored = store
      .get("workflowRuns")
      ?.get(encodeURIComponent(run.id)) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("parentRunId");
    expect(stored).not.toHaveProperty("currentStepId");
    expect(stored).not.toHaveProperty("completedAt");
  });

  it("get() returns the parsed document by id", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    await db.create(Collections.repositories, makeRepo({ id: "g/h" }));
    const got = await db.get(Collections.repositories, "g/h");
    expect(got?.id).toBe("g/h");
  });

  it("get() returns undefined for an unknown id", async () => {
    const { fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(new Map());
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    const got = await db.get(Collections.repositories, "nope/none");
    expect(got).toBeUndefined();
  });

  it("list() returns all documents when no filter is supplied", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    await db.create(Collections.repositories, makeRepo({ id: "a/x" }));
    await db.create(Collections.repositories, makeRepo({ id: "b/y" }));
    const all = await db.list(Collections.repositories);
    expect(all).toHaveLength(2);
  });

  it("list() applies a partial-equality filter via admin .where()", async () => {
    const { store, fakeFirestore: adminFs } = makeFakeAdmin();
    const client = makeFakeClient(store);
    const db = createHostedFirestoreDb({
      adminFirestore: adminFs,
      clientFirestoreModule: client,
    });
    await db.create(
      Collections.repositories,
      makeRepo({ id: "a/x", owner: "a" }),
    );
    await db.create(
      Collections.repositories,
      makeRepo({ id: "b/y", owner: "b" }),
    );
    const onlyA = await db.list(Collections.repositories, { owner: "a" });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]?.id).toBe("a/x");
  });
});
