/**
 * Integration tests for HostedFirestoreDb.
 *
 * These tests require the Firebase Emulator to be running:
 *   firebase emulators:start --only firestore
 *
 * The FIRESTORE_EMULATOR_HOST environment variable must be set to
 * "localhost:8080" (or the emulator will not be used). Tests are skipped
 * automatically when the emulator is not reachable.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { Repository } from "../schemas/index.js";

const EMULATOR_HOST = process.env["FIRESTORE_EMULATOR_HOST"] ?? "localhost:8080";
const EMULATOR_PROJECT = "pr-shepherd-test";

function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    owner: "test-org",
    name: "test-repo",
    enabled: true,
    workflowMap: {},
    concurrencyMax: 2,
    createdAt: Date.now(),
    ...overrides,
  };
}

async function isEmulatorRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://${EMULATOR_HOST}/`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

describe("HostedFirestoreDb", () => {
  let emulatorAvailable = false;

  beforeAll(async () => {
    emulatorAvailable = await isEmulatorRunning();
    if (!emulatorAvailable) return;

    // Point firebase-admin at the emulator
    process.env["FIRESTORE_EMULATOR_HOST"] = EMULATOR_HOST;
    process.env["FIREBASE_PROJECT_ID"] = EMULATOR_PROJECT;
    process.env["FIREBASE_CLIENT_EMAIL"] = "test@test.com";
    process.env["FIREBASE_PRIVATE_KEY"] = "unused-in-emulator";
  });

  afterAll(() => {
    // Clean up env vars set for this suite
    delete process.env["FIRESTORE_EMULATOR_HOST"];
    delete process.env["FIREBASE_PROJECT_ID"];
    delete process.env["FIREBASE_CLIENT_EMAIL"];
    delete process.env["FIREBASE_PRIVATE_KEY"];
  });

  describe("when emulator is running", () => {
    let db: import("./hostedFirestore.js").HostedFirestoreDb | undefined;
    let createdIds: string[] = [];

    beforeEach(async () => {
      if (!emulatorAvailable) return;
      const { HostedFirestoreDb } = await import("./hostedFirestore.js");
      db = new HostedFirestoreDb();
      createdIds = [];
    });

    afterEach(async () => {
      if (!emulatorAvailable || !db) return;
      for (const id of createdIds) {
        await db.delete("repositories", id).catch(() => undefined);
      }
    });

    it("write-then-read round-trip", async () => {
      if (!emulatorAvailable || !db) return;

      const repo = makeRepository();
      createdIds.push(repo.id);

      await db.create("repositories", repo);
      const result = await db.get("repositories", repo.id);

      expect(result).toBeDefined();
      expect(result?.id).toBe(repo.id);
      expect(result?.owner).toBe(repo.owner);
    });

    it("list returns created documents", async () => {
      if (!emulatorAvailable || !db) return;

      const repo1 = makeRepository({ name: "alpha" });
      const repo2 = makeRepository({ name: "beta" });
      createdIds.push(repo1.id, repo2.id);

      await db.create("repositories", repo1);
      await db.create("repositories", repo2);

      const results = await db.list("repositories", [
        { field: "owner", op: "==", value: "test-org" },
      ]);
      const ids = results.map((r) => r.id);
      expect(ids).toContain(repo1.id);
      expect(ids).toContain(repo2.id);
    });

    it("update patches an existing document", async () => {
      if (!emulatorAvailable || !db) return;

      const repo = makeRepository({ enabled: true });
      createdIds.push(repo.id);

      await db.create("repositories", repo);
      const updated = await db.update("repositories", repo.id, {
        enabled: false,
      });

      expect(updated.enabled).toBe(false);
      expect(updated.id).toBe(repo.id);
    });

    it("delete removes a document", async () => {
      if (!emulatorAvailable || !db) return;

      const repo = makeRepository();
      await db.create("repositories", repo);
      await db.delete("repositories", repo.id);

      const result = await db.get("repositories", repo.id);
      expect(result).toBeUndefined();
    });

    it("subscribe write-then-subscribe round-trip with unsubscribe", async () => {
      if (!emulatorAvailable || !db) return;

      const repo = makeRepository({ name: "subscribe-test" });
      createdIds.push(repo.id);

      await db.create("repositories", repo);

      const received: Repository[][] = [];
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("subscribe timeout"));
        }, 5000);

        const unsubscribe = db!.subscribe("repositories", undefined, (docs) => {
          const match = docs.filter((d) => d.id === repo.id);
          if (match.length > 0) {
            received.push(docs);
            clearTimeout(timeout);
            unsubscribe();
            resolve();
          }
        });
      });

      expect(received.length).toBeGreaterThan(0);
      const matchingDoc = received[0]?.find((d) => d.id === repo.id);
      expect(matchingDoc).toBeDefined();
      expect(matchingDoc?.name).toBe("subscribe-test");
    });

    it("unsubscribe stops receiving updates", async () => {
      if (!emulatorAvailable || !db) return;

      const repo = makeRepository();
      createdIds.push(repo.id);

      const received: Repository[][] = [];

      await new Promise<void>((resolve) => {
        const unsubscribe = db!.subscribe("repositories", undefined, (docs) => {
          received.push(docs);
          // unsubscribe after first snapshot
          unsubscribe();
          resolve();
        });
      });

      const countBeforeCreate = received.length;

      // Create a document after unsubscribing — should not trigger the listener
      await db.create("repositories", repo);
      await new Promise((r) => setTimeout(r, 500));

      expect(received.length).toBe(countBeforeCreate);
    });
  });

  describe("when emulator is not running", () => {
    it("skips gracefully", () => {
      if (emulatorAvailable) return;
      // No emulator — integration tests skipped
    });
  });
});
