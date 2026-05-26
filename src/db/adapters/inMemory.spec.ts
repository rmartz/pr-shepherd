import { describe, it, expect, vi } from "vitest";
import { createInMemoryDb } from "./inMemory";
import { Collections } from "../collections";
import type { Repository } from "../schemas";

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "rmartz/pr-shepherd",
    owner: "rmartz",
    name: "pr-shepherd",
    enabled: true,
    workflowMap: { "*": "base-pr" },
    concurrencyMax: 2,
    createdAt: 1716700000000,
    ...overrides,
  };
}

describe("Db CRUD round-trip on the in-memory adapter", () => {
  it("creates and reads back a document by id", async () => {
    const db = createInMemoryDb();
    const repo = makeRepo();
    await db.create(Collections.repositories, repo);
    const read = await db.get(Collections.repositories, repo.id);
    expect(read).toEqual(repo);
  });

  it("lists all documents in a collection", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.repositories,
      makeRepo({ id: "a/x", owner: "a" }),
    );
    await db.create(
      Collections.repositories,
      makeRepo({ id: "b/y", owner: "b" }),
    );
    const all = await db.list(Collections.repositories);
    expect(all).toHaveLength(2);
  });

  it("filters list results by partial field equality", async () => {
    const db = createInMemoryDb();
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

  it("updates a document by patching a subset of fields", async () => {
    const db = createInMemoryDb();
    const repo = makeRepo({ concurrencyMax: 2 });
    await db.create(Collections.repositories, repo);
    await db.update(Collections.repositories, repo.id, { concurrencyMax: 8 });
    const updated = await db.get(Collections.repositories, repo.id);
    expect(updated?.concurrencyMax).toBe(8);
    expect(updated?.owner).toBe(repo.owner);
  });

  it("deletes a document by id", async () => {
    const db = createInMemoryDb();
    const repo = makeRepo();
    await db.create(Collections.repositories, repo);
    await db.delete(Collections.repositories, repo.id);
    const read = await db.get(Collections.repositories, repo.id);
    expect(read).toBeUndefined();
  });

  it("returns undefined for an unknown id", async () => {
    const db = createInMemoryDb();
    const read = await db.get(Collections.repositories, "nope/none");
    expect(read).toBeUndefined();
  });
});

describe("Db subscription dispatch on the in-memory adapter", () => {
  it("invokes the callback with the current snapshot on subscribe", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.repositories, makeRepo());
    const onChange = vi.fn();
    const unsubscribe = db.subscribe(
      Collections.repositories,
      undefined,
      onChange,
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toHaveLength(1);
    unsubscribe();
  });

  it("invokes the callback again when a new document is created", async () => {
    const db = createInMemoryDb();
    const onChange = vi.fn();
    const unsubscribe = db.subscribe(
      Collections.repositories,
      undefined,
      onChange,
    );
    onChange.mockClear();
    await db.create(Collections.repositories, makeRepo());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toHaveLength(1);
    unsubscribe();
  });

  it("stops invoking the callback after unsubscribe", async () => {
    const db = createInMemoryDb();
    const onChange = vi.fn();
    const unsubscribe = db.subscribe(
      Collections.repositories,
      undefined,
      onChange,
    );
    unsubscribe();
    onChange.mockClear();
    await db.create(Collections.repositories, makeRepo());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("respects the filter — only emits matching documents to the callback", async () => {
    const db = createInMemoryDb();
    const onChange = vi.fn();
    const unsubscribe = db.subscribe(
      Collections.repositories,
      { owner: "a" },
      onChange,
    );
    onChange.mockClear();
    await db.create(
      Collections.repositories,
      makeRepo({ id: "a/x", owner: "a" }),
    );
    await db.create(
      Collections.repositories,
      makeRepo({ id: "b/y", owner: "b" }),
    );
    const lastCall = onChange.mock.calls.at(-1);
    expect(lastCall?.[0]).toHaveLength(1);
    expect(lastCall?.[0][0].owner).toBe("a");
    unsubscribe();
  });
});
