import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryDb } from "./inMemory.js";
import type { Repository } from "../schemas/index.js";

function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "acme/backend",
    owner: "acme",
    name: "backend",
    enabled: true,
    workflowMap: {},
    concurrencyMax: 2,
    createdAt: 1700000000000,
    ...overrides,
  };
}

describe("InMemoryDb", () => {
  let db: InMemoryDb;

  beforeEach(() => {
    db = new InMemoryDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("get", () => {
    it("returns undefined for a missing document", async () => {
      const result = await db.get("repositories", "nonexistent");
      expect(result).toBeUndefined();
    });

    it("returns the document after it is created", async () => {
      const repo = makeRepository({ id: "org/repo" });
      await db.create("repositories", repo);
      const result = await db.get("repositories", "org/repo");
      expect(result).toEqual(repo);
    });
  });

  describe("list", () => {
    it("returns an empty array when collection is empty", async () => {
      const results = await db.list("repositories");
      expect(results).toEqual([]);
    });

    it("returns all documents with no filters", async () => {
      const repo1 = makeRepository({ id: "org/repo1" });
      const repo2 = makeRepository({ id: "org/repo2" });
      await db.create("repositories", repo1);
      await db.create("repositories", repo2);
      const results = await db.list("repositories");
      expect(results).toHaveLength(2);
    });

    it("filters documents with == filter", async () => {
      const enabled = makeRepository({ id: "org/enabled", enabled: true });
      const disabled = makeRepository({ id: "org/disabled", enabled: false });
      await db.create("repositories", enabled);
      await db.create("repositories", disabled);
      const results = await db.list("repositories", [
        { field: "enabled", op: "==", value: true },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe("org/enabled");
    });

    it("filters documents with != filter", async () => {
      const repo1 = makeRepository({ id: "org/repo1", concurrencyMax: 2 });
      const repo2 = makeRepository({ id: "org/repo2", concurrencyMax: 5 });
      await db.create("repositories", repo1);
      await db.create("repositories", repo2);
      const results = await db.list("repositories", [
        { field: "concurrencyMax", op: "!=", value: 2 },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe("org/repo2");
    });
  });

  describe("create", () => {
    it("stores and returns the document", async () => {
      const repo = makeRepository({ id: "org/new" });
      const result = await db.create("repositories", repo);
      expect(result).toEqual(repo);
    });

    it("overwrites an existing document with the same id", async () => {
      const original = makeRepository({ id: "org/repo", enabled: true });
      const overwrite = makeRepository({ id: "org/repo", enabled: false });
      await db.create("repositories", original);
      await db.create("repositories", overwrite);
      const result = await db.get("repositories", "org/repo");
      expect(result?.enabled).toBe(false);
    });
  });

  describe("update", () => {
    it("applies a partial patch to an existing document", async () => {
      const repo = makeRepository({ id: "org/repo", enabled: true });
      await db.create("repositories", repo);
      const result = await db.update("repositories", "org/repo", {
        enabled: false,
      });
      expect(result.enabled).toBe(false);
      expect(result.id).toBe("org/repo");
    });

    it("throws when updating a non-existent document", async () => {
      await expect(
        db.update("repositories", "missing", { enabled: false }),
      ).rejects.toThrow();
    });
  });

  describe("delete", () => {
    it("removes the document from the collection", async () => {
      const repo = makeRepository({ id: "org/repo" });
      await db.create("repositories", repo);
      await db.delete("repositories", "org/repo");
      const result = await db.get("repositories", "org/repo");
      expect(result).toBeUndefined();
    });

    it("is a no-op for a non-existent document", async () => {
      await expect(
        db.delete("repositories", "nonexistent"),
      ).resolves.toBeUndefined();
    });
  });

  describe("subscribe", () => {
    it("fires immediately with current collection state", async () => {
      const repo = makeRepository({ id: "org/repo" });
      await db.create("repositories", repo);

      const received: Repository[][] = [];
      const unsubscribe = db.subscribe("repositories", undefined, (docs) => {
        received.push(docs);
      });

      expect(received).toHaveLength(1);
      expect(received[0]).toHaveLength(1);
      expect(received[0]?.[0]?.id).toBe("org/repo");

      unsubscribe();
    });

    it("fires on document creation after subscription", async () => {
      const received: Repository[][] = [];
      const unsubscribe = db.subscribe("repositories", undefined, (docs) => {
        received.push(docs);
      });

      const repo = makeRepository({ id: "org/repo" });
      await db.create("repositories", repo);

      expect(received).toHaveLength(2);
      expect(received[1]).toHaveLength(1);

      unsubscribe();
    });

    it("fires on document update after subscription", async () => {
      const repo = makeRepository({ id: "org/repo", enabled: true });
      await db.create("repositories", repo);

      const received: Repository[][] = [];
      const unsubscribe = db.subscribe("repositories", undefined, (docs) => {
        received.push(docs);
      });

      await db.update("repositories", "org/repo", { enabled: false });

      expect(received).toHaveLength(2);
      expect(received[1]?.[0]?.enabled).toBe(false);

      unsubscribe();
    });

    it("does not fire after unsubscribe", async () => {
      const received: Repository[][] = [];
      const unsubscribe = db.subscribe("repositories", undefined, (docs) => {
        received.push(docs);
      });
      unsubscribe();

      await db.create("repositories", makeRepository({ id: "org/repo" }));

      expect(received).toHaveLength(1);
    });

    it("applies filters to subscription updates", async () => {
      const received: Repository[][] = [];
      const unsubscribe = db.subscribe(
        "repositories",
        [{ field: "enabled", op: "==", value: true }],
        (docs) => {
          received.push(docs);
        },
      );

      await db.create(
        "repositories",
        makeRepository({ id: "org/enabled", enabled: true }),
      );
      await db.create(
        "repositories",
        makeRepository({ id: "org/disabled", enabled: false }),
      );

      const lastBatch = received[received.length - 1];
      expect(lastBatch).toHaveLength(1);
      expect(lastBatch?.[0]?.id).toBe("org/enabled");

      unsubscribe();
    });
  });
});
