// Public surface of the daemon's adapter-agnostic data layer.
//
// Consumers import:
//   - `Db`, `CollectionDef`, `Filter`, `Unsubscribe` types from here
//   - `Collections` registry for the four daemon-managed collections
//   - `createDb(config)` factory to obtain the configured adapter
//
// Schemas remain re-exported from `./schemas`.
export type {
  CollectionDef,
  Db,
  Filter,
  SubscriptionCallback,
  Unsubscribe,
} from "./types";
export { Collections } from "./collections";
export * from "./schemas";

import {
  createHostedFirestoreDb,
  SubscriptionSource,
} from "./adapters/hostedFirestore";
import { createInMemoryDb } from "./adapters/inMemory";
import type { Db } from "./types";

// Configuration for the Db factory. Adapter values map to:
//   - `in-memory`        — the test adapter (this PR)
//   - `firebase-hosted`  — production path, implemented in #38
//   - `firebase-emulator`— local dev path, implemented in #39
//   - `leveldb`          — stretch goal, not in current scope
export enum DbAdapterKind {
  FirebaseEmulator = "firebase-emulator",
  FirebaseHosted = "firebase-hosted",
  InMemory = "in-memory",
  Leveldb = "leveldb",
}

// Optional emulator configuration. Only consulted when
// `adapter == "firebase-emulator"`. `firestoreHost` may be a `host:port`
// string (e.g. `127.0.0.1:8080`). This wires the daemon's
// firebase-admin SDK only — it sets `FIRESTORE_EMULATOR_HOST` on the
// daemon process, which the admin SDK reads natively.
//
// The Vercel-hosted UI is a Next.js browser bundle and cannot read
// non-`NEXT_PUBLIC_*` env vars at runtime, so the daemon's env-var
// write does NOT reach the UI. For UI dev against the same emulator,
// set `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST=localhost:8080` in the UI's
// `.env.local`. See `docs/local-development.md` for the full setup.
export interface EmulatorConfig {
  firestoreHost?: string;
}

export interface DbConfig {
  adapter: DbAdapterKind;
  emulator?: EmulatorConfig;
}

const DEFAULT_EMULATOR_FIRESTORE_HOST = "localhost:8080";

// Helper to keep adapter selection deterministic across repeated
// `createDb` calls in the same process: when the requested adapter is
// not the emulator, an `FIRESTORE_EMULATOR_HOST` left over from an
// earlier emulator construction (or set by an outer environment) would
// silently re-route the admin SDK. Clear it explicitly.
function clearEmulatorEnv(): void {
  delete process.env["FIRESTORE_EMULATOR_HOST"];
}

export function createDb(config: DbConfig): Db {
  switch (config.adapter) {
    case DbAdapterKind.FirebaseHosted:
      clearEmulatorEnv();
      // The daemon owns this factory; subscriptions go through the admin SDK
      // (rules-bypassing, any collection). The UI subscribes via the client
      // SDK directly (`src/lib/firebase/client`), not through `createDb`.
      return createHostedFirestoreDb({
        subscriptionSource: SubscriptionSource.Admin,
      });
    case DbAdapterKind.InMemory:
      clearEmulatorEnv();
      return createInMemoryDb();
    case DbAdapterKind.FirebaseEmulator: {
      // The Firebase admin SDK reads `FIRESTORE_EMULATOR_HOST` natively
      // and routes every collection/doc call to the emulator when set.
      // Setting the variable here is what makes the otherwise-identical
      // hosted adapter point at the local emulator from the daemon
      // side. The UI side is configured separately via
      // `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST` (see `EmulatorConfig`
      // doc-comment).
      const host =
        config.emulator?.firestoreHost ?? DEFAULT_EMULATOR_FIRESTORE_HOST;
      process.env["FIRESTORE_EMULATOR_HOST"] = host;
      return createHostedFirestoreDb({
        subscriptionSource: SubscriptionSource.Admin,
      });
    }
    case DbAdapterKind.Leveldb:
      clearEmulatorEnv();
      throw new Error(
        `Adapter "leveldb" is out of scope for v1 — see Epic 2 stretch goal.`,
      );
    default: {
      // Exhaustiveness guard: any new `DbAdapterKind` value must add a
      // corresponding case above. Without this, a config value that
      // arrives via type assertion or untyped YAML parse would fall
      // through and return `undefined` despite the `Db` return type.
      const _exhaustive: never = config.adapter;
      throw new Error(`Unknown db adapter: ${String(_exhaustive)}`);
    }
  }
}
