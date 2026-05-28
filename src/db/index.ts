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

import { createHostedFirestoreDb } from "./adapters/hostedFirestore";
import { createInMemoryDb } from "./adapters/inMemory";
import type { Db } from "./types";

// Configuration for the Db factory. Adapter values map to:
//   - `in-memory`        — the test adapter (this PR)
//   - `firebase-hosted`  — production path, implemented in #38
//   - `firebase-emulator`— local dev path, implemented in #39
//   - `leveldb`          — stretch goal, not in current scope
export type DbAdapterKind =
  | "firebase-emulator"
  | "firebase-hosted"
  | "in-memory"
  | "leveldb";

// Optional emulator configuration. Only consulted when
// `adapter == "firebase-emulator"`. `firestoreHost` may be a `host:port`
// string (e.g. `127.0.0.1:8080`); the daemon translates it to
// `FIRESTORE_EMULATOR_HOST` for the admin SDK and to a
// `connectFirestoreEmulator(client, host, port)` call for the UI client
// SDK (see `src/lib/firebase/client.ts`).
export interface EmulatorConfig {
  firestoreHost?: string;
}

export interface DbConfig {
  adapter: DbAdapterKind;
  emulator?: EmulatorConfig;
}

const DEFAULT_EMULATOR_FIRESTORE_HOST = "localhost:8080";

export function createDb(config: DbConfig): Db {
  switch (config.adapter) {
    case "firebase-hosted":
      return createHostedFirestoreDb();
    case "in-memory":
      return createInMemoryDb();
    case "firebase-emulator": {
      // The Firebase admin SDK reads `FIRESTORE_EMULATOR_HOST` natively
      // and routes every collection/doc call to the emulator when set.
      // The client SDK (see `getClientFirestore`) checks the same env
      // var on first call and invokes `connectFirestoreEmulator` —
      // setting the variable here is what makes the otherwise-identical
      // hosted adapter point at the local emulator.
      const host =
        config.emulator?.firestoreHost ?? DEFAULT_EMULATOR_FIRESTORE_HOST;
      process.env["FIRESTORE_EMULATOR_HOST"] = host;
      return createHostedFirestoreDb();
    }
    case "leveldb":
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
