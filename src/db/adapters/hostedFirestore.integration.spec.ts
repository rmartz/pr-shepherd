import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  createHostedFirestoreDb,
  type HostedFirestoreDbOptions,
} from "./hostedFirestore";
import { Collections } from "../collections";
import type { Repository } from "../schemas";

// ---------------------------------------------------------------------------
// Integration coverage for the hosted Firestore adapter against the Firebase
// Emulator. Skips gracefully when the emulator is not reachable so the unit
// suite stays green on machines without `firebase emulators:start` running.
//
// To run the full path locally:
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
//   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
//   pnpm test src/db/adapters/hostedFirestore.integration.spec.ts
// ---------------------------------------------------------------------------

const EMULATOR_HOST =
  process.env["FIRESTORE_EMULATOR_HOST"] ?? "127.0.0.1:8080";

async function emulatorReachable(): Promise<boolean> {
  try {
    const res = await fetch(`http://${EMULATOR_HOST}/`, {
      signal: AbortSignal.timeout(500),
    });
    // The emulator returns 200 with "Ok" on root.
    return res.ok;
  } catch {
    return false;
  }
}

let noEmulator = true;

beforeAll(async () => {
  noEmulator = !(await emulatorReachable());
  if (noEmulator) return;
  // Point the admin SDK at the emulator. Setting both env vars is what the
  // SDK reads on initialization, so we set them before importing the
  // Firebase modules below.
  process.env["FIRESTORE_EMULATOR_HOST"] = EMULATOR_HOST;
  process.env["FIREBASE_PROJECT_ID"] = "demo-pr-shepherd-emulator";
});

afterAll(() => {
  // No teardown needed — the emulator persists state across runs of this
  // file and other suites; tests below use unique ids to avoid collisions.
});

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: `int-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    owner: "rmartz",
    name: "pr-shepherd",
    enabled: true,
    workflowMap: { "*": "base-pr" },
    concurrencyMax: 2,
    createdAt: 1716700000000,
    ...overrides,
  };
}

describe("HostedFirestoreDb integration with the Firebase Emulator", () => {
  it.skipIf(noEmulator)(
    "write-then-subscribe round-trip including unsubscribe",
    async () => {
      // Lazy-import so the unit suite never loads the real Firebase modules.
      const { initializeApp, getApps } = await import("firebase/app");
      const {
        getFirestore,
        connectFirestoreEmulator,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } = (await import("firebase/firestore")) as any;
      const adminApp = await import("firebase-admin/app");
      const adminFs = await import("firebase-admin/firestore");

      // Initialize the admin SDK pointing at the emulator (no credential
      // required — the emulator accepts the default project).
      if (
        adminApp.getApps().find((a) => a.name === "[DEFAULT]") === undefined
      ) {
        adminApp.initializeApp({
          projectId: process.env["FIREBASE_PROJECT_ID"],
        });
      }
      const admin = adminFs.getFirestore();

      // Initialize the client SDK pointing at the same emulator.
      const clientApp =
        getApps().find((a) => a.name === "int-test") ??
        initializeApp(
          { projectId: process.env["FIREBASE_PROJECT_ID"] },
          "int-test",
        );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const client = getFirestore(clientApp);
      const [host, portStr] = EMULATOR_HOST.split(":");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      connectFirestoreEmulator(client, host, Number(portStr));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clientMod = (await import("firebase/firestore")) as any;

      const db = createHostedFirestoreDb({
        adminFirestore:
          admin as unknown as HostedFirestoreDbOptions["adminFirestore"],
        clientFirestoreModule: clientMod,
        clientFirestore: client,
      });

      const repo = makeRepo();
      const onChange = vi.fn();

      const unsubscribe = db.subscribe(
        Collections.repositories,
        { id: repo.id },
        onChange,
      );

      try {
        await db.create(Collections.repositories, repo);

        // Wait for the snapshot to arrive — onSnapshot is push-based but the
        // emulator round-trip has a small delay.
        await vi.waitFor(
          () => {
            const last = onChange.mock.calls.at(-1);
            expect(last?.[0]?.length).toBeGreaterThanOrEqual(1);
          },
          { timeout: 5000, interval: 100 },
        );

        const last = onChange.mock.calls.at(-1);
        expect(last?.[0]?.[0]?.id).toBe(repo.id);

        // Verify the unsubscribe path: after unsubscribing, a subsequent
        // create on a different id should NOT trigger our callback.
        unsubscribe();
        onChange.mockClear();
        await db.create(Collections.repositories, makeRepo());
        // Give the emulator time to fire any pending snapshots; if our
        // unsubscribe is wired correctly, none should arrive.
        await new Promise((r) => setTimeout(r, 500));
        expect(onChange).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        await db.delete(Collections.repositories, repo.id).catch(() => {
          // best-effort cleanup
        });
      }
    },
    15000,
  );
});
