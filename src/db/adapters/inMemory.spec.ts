import { describe, it, expect, vi } from "vitest";
import { createInMemoryDb } from "./inMemory";
import { createDb, DbAdapterKind } from "../index";
import { Collections } from "../collections";
import {
  WebhookEventType,
  type Repository,
  type WebhookEvent,
} from "../schemas";
import { ComparisonOp } from "../types";

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

describe("Filter handles undefined values as 'not specified'", () => {
  it("ignores a filter key whose value is undefined", async () => {
    const db = createInMemoryDb();
    await db.create(
      Collections.repositories,
      makeRepo({ id: "a/x", owner: "a" }),
    );
    await db.create(
      Collections.repositories,
      makeRepo({ id: "b/y", owner: "b" }),
    );
    const owner: string | undefined = undefined;
    const result = await db.list(Collections.repositories, { owner });
    expect(result).toHaveLength(2);
  });
});

describe("list applies range constraints over an ordered field", () => {
  function makeEvent(receivedAt: number): WebhookEvent {
    return {
      id: `evt-${String(receivedAt)}`,
      deliveryId: `evt-${String(receivedAt)}`,
      eventType: WebhookEventType.PullRequest,
      payload: { action: "opened" },
      receivedAt,
    };
  }

  it("returns only documents at or above a >= threshold", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.webhookEvents, makeEvent(100));
    await db.create(Collections.webhookEvents, makeEvent(500));
    await db.create(Collections.webhookEvents, makeEvent(900));
    const recent = await db.list(Collections.webhookEvents, undefined, [
      {
        field: "receivedAt",
        op: ComparisonOp.GreaterThanOrEqual,
        value: 500,
      },
    ]);
    expect(recent.map((e) => e.receivedAt).sort((a, b) => a - b)).toEqual([
      500, 900,
    ]);
  });

  it("ANDs a range constraint with an equality filter", async () => {
    const db = createInMemoryDb();
    await db.create(Collections.webhookEvents, {
      ...makeEvent(900),
      eventType: WebhookEventType.PullRequest,
    });
    await db.create(Collections.webhookEvents, {
      ...makeEvent(950),
      id: "push-950",
      deliveryId: "push-950",
      eventType: WebhookEventType.Push,
    });
    const recentPrEvents = await db.list(
      Collections.webhookEvents,
      { eventType: WebhookEventType.PullRequest },
      [
        {
          field: "receivedAt",
          op: ComparisonOp.GreaterThanOrEqual,
          value: 500,
        },
      ],
    );
    expect(recentPrEvents).toHaveLength(1);
    expect(recentPrEvents[0]?.eventType).toBe(WebhookEventType.PullRequest);
  });
});

describe("update rejects patching the collection id field", () => {
  it("throws when patch attempts to change the id to a different value", async () => {
    const db = createInMemoryDb();
    const repo = makeRepo({ id: "a/x", owner: "a" });
    await db.create(Collections.repositories, repo);
    await expect(
      db.update(Collections.repositories, "a/x", { id: "b/y" }),
    ).rejects.toThrow(/Cannot change/);
  });

  it("allows a patch whose id field matches the document key (no-op)", async () => {
    const db = createInMemoryDb();
    const repo = makeRepo({ id: "a/x", owner: "a" });
    await db.create(Collections.repositories, repo);
    await db.update(Collections.repositories, "a/x", {
      id: "a/x",
      concurrencyMax: 8,
    });
    const updated = await db.get(Collections.repositories, "a/x");
    expect(updated?.concurrencyMax).toBe(8);
  });
});

describe("notify() snapshots the subscription list", () => {
  it("dispatches to every subscriber when one unsubscribes from inside its own callback", async () => {
    const db = createInMemoryDb();
    const firstSeen: number[] = [];
    const secondSeen: number[] = [];
    const unsubscribeFirst = db.subscribe(
      Collections.repositories,
      undefined,
      (docs) => {
        firstSeen.push(docs.length);
        // Unsubscribing during the first dispatch must not cause the
        // second subscriber to be skipped on this same notification.
        if (docs.length === 1) unsubscribeFirst();
      },
    );
    const unsubscribeSecond = db.subscribe(
      Collections.repositories,
      undefined,
      (docs) => {
        secondSeen.push(docs.length);
      },
    );
    firstSeen.length = 0;
    secondSeen.length = 0;
    await db.create(Collections.repositories, makeRepo());
    expect(firstSeen).toEqual([1]);
    expect(secondSeen).toEqual([1]);
    unsubscribeSecond();
  });
});

describe("createDb factory exhaustiveness", () => {
  it("returns the in-memory adapter for the in-memory kind", () => {
    expect(createDb({ adapter: DbAdapterKind.InMemory })).toBeDefined();
  });

  it("throws a clear error for an unknown adapter value", () => {
    expect(() =>
      createDb({
        adapter: "unknown-adapter" as unknown as DbAdapterKind,
      }),
    ).toThrow(/Unknown db adapter/);
  });
});

describe("create() rejects documents whose id field is not a non-empty string", () => {
  it("throws when the id field parses to an empty string", async () => {
    const db = createInMemoryDb();
    await expect(
      db.create(Collections.repositories, makeRepo({ id: "" })),
    ).rejects.toThrow();
  });
});
