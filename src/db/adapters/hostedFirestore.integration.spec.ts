import { describe, it, expect, vi } from "vitest";
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
  it("write-then-subscribe round-trip including unsubscribe", async (ctx) => {
    if (!(await emulatorReachable())) {
      // Report as skipped (not passed) so test reporters can distinguish
      // "emulator coverage actually ran" from "happens to be unreachable".
      ctx.skip();
      return;
    }
    // Point the admin SDK at the emulator. Setting both env vars is what the
    // SDK reads on initialization, so we set them before importing the
    // Firebase modules below.
    process.env["FIRESTORE_EMULATOR_HOST"] = EMULATOR_HOST;
    process.env["FIREBASE_PROJECT_ID"] = "demo-pr-shepherd-emulator";

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
    if (adminApp.getApps().find((a) => a.name === "[DEFAULT]") === undefined) {
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

    // Subscribe with an exact-id filter so we only observe this test's
    // writes — protects against emulator state contamination from other
    // tests or prior runs.
    const unsubscribe = db.subscribe(
      Collections.repositories,
      { id: repo.id },
      onChange,
    );

    try {
      await db.create(Collections.repositories, repo);

      // Wait for the snapshot to arrive — onSnapshot is push-based but the
      // emulator round-trip has a small delay. Assert the snapshot CONTAINS
      // this test's repo rather than is-at-index-0, since order across
      // filter passes is not guaranteed.
      await vi.waitFor(
        () => {
          const last = onChange.mock.calls.at(-1) as [Repository[]] | undefined;
          expect(last?.[0]?.some((d) => d.id === repo.id)).toBe(true);
        },
        { timeout: 5000, interval: 100 },
      );

      // Verify the unsubscribe path: after unsubscribing, an update to the
      // very document the subscription was filtering on must not trigger
      // our callback.
      unsubscribe();
      onChange.mockClear();
      await db.update(Collections.repositories, repo.id, {
        concurrencyMax: repo.concurrencyMax + 1,
      });
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
  }, 15000);
});
