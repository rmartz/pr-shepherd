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

export interface DbConfig {
  adapter: DbAdapterKind;
}

export function createDb(config: DbConfig): Db {
  switch (config.adapter) {
    case "in-memory":
      return createInMemoryDb();
    case "firebase-hosted":
    case "firebase-emulator":
      throw new Error(
        `Adapter "${config.adapter}" not yet implemented — see issue #38 (hosted) / #39 (emulator).`,
      );
    case "leveldb":
      throw new Error(
        `Adapter "leveldb" is out of scope for v1 — see Epic 2 stretch goal.`,
      );
  }
}
