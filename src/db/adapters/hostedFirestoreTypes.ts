import * as firestoreClientSdk from "firebase/firestore";
import { getClientFirestore } from "../../lib/firebase/client";
import { Collections } from "../collections";
import type { CollectionDef, Filter } from "../types";
import type { AdminFirestoreLike } from "./firestoreAdminTypes";

// ---------------------------------------------------------------------------
// Types, constants, and adapter utilities for `HostedFirestoreDb`.
//
// - Types: `ClientFirestoreModule`, `MakeIncrement`, `SubscriptionSource`,
//   `HostedFirestoreDbOptions`
// - Runtime helpers: `loadDefaultAdmin`, `loadDefaultMakeIncrement`,
//   `loadDefaultClient`, `stripUndefinedDeep`, `extractId`, `toDocKey`,
//   `filterEntries`
//
// See `HostedFirestoreDb` in `hostedFirestore.ts` for the implementation and
// its capability split (client vs. admin subscription paths, lazy admin SDK
// loading, test-injectable handles).
// ---------------------------------------------------------------------------

// Internal shape returned by the client-SDK `onSnapshot`.
interface ClientQuerySnapshot {
  docs: { id: string; data: () => unknown }[];
}

// The Firebase client SDK exposes these as free functions, not methods —
// mirror that shape for injection in tests.
export interface ClientFirestoreModule {
  collection: (db: unknown, name: string) => unknown;
  query: (base: unknown, ...constraints: unknown[]) => unknown;
  where: (field: string, op: "==", value: unknown) => unknown;
  onSnapshot: (
    q: unknown,
    onNext: (snap: ClientQuerySnapshot) => void,
  ) => () => void;
}

// Produces an atomic field-increment sentinel for `docRef.update`. In
// production this is `FieldValue.increment` from `firebase-admin/firestore`;
// tests inject a fake so the unit suite never loads the admin SDK.
export type MakeIncrement = (by: number) => unknown;

// Selects which SDK `subscribe()` listens through. The daemon constructs the
// adapter with `Admin`; the UI uses the default `Client` path.
export enum SubscriptionSource {
  Admin = "admin",
  Client = "client",
}

export interface HostedFirestoreDbOptions {
  // Inject for tests. When omitted, the admin SDK is dynamically imported
  // on first admin method call.
  adminFirestore?: AdminFirestoreLike;
  // Inject for tests. Defaults to the statically-imported `firebase/firestore`
  // module bound to the client Firestore handle from
  // `src/lib/firebase/client`.
  clientFirestoreModule?: ClientFirestoreModule;
  // Inject for tests. Defaults to `getClientFirestore()`.
  clientFirestore?: unknown;
  // Which SDK `subscribe()` listens through. Defaults to `Client` so existing
  // UI consumers are unaffected; the daemon passes `Admin`.
  subscriptionSource?: SubscriptionSource;
  // Backoff tuning for the admin subscription manager. Injectable for tests.
  adminSubscribeBaseBackoffMs?: number;
  adminSubscribeMaxBackoffMs?: number;
  // Inject for tests. Defaults to a lazy `FieldValue.increment` from the
  // dynamically-imported admin SDK.
  makeIncrement?: MakeIncrement;
}

// Client-subscribable collection names — UI-readable per `firestore.rules`.
// The client `subscribe()` path throws for any other collection so an
// out-of-bounds UI subscription fails fast with a clear error rather than
// surfacing as an opaque permission-denied from Firestore. The admin path
// has no such gate: the service-account credentials bypass rules, so the
// daemon may subscribe to any collection (`commands`, derivation triggers,
// etc.).
export const SUBSCRIBABLE_COLLECTIONS = new Set<string>([
  Collections.repositories.name,
  Collections.stepInstances.name,
  Collections.workflowDefinitions.name,
  Collections.workflowRuns.name,
]);

// Dynamically load the admin firestore handle. The `await import()` keeps
// `firebase-admin` out of any client bundle that does not reach this code
// path. The resolved module is cached at the call site so repeated admin
// operations do not re-import.
export async function loadDefaultAdmin(): Promise<AdminFirestoreLike> {
  const mod = await import("../../lib/firebase/admin");
  return mod.getAdminFirestore() as unknown as AdminFirestoreLike;
}

// Dynamically load `FieldValue.increment` from the admin SDK. Kept off the
// static import graph (same rationale as `loadDefaultAdmin`) so a client
// bundle that never increments does not pull in `firebase-admin`.
export async function loadDefaultMakeIncrement(): Promise<MakeIncrement> {
  const mod = await import("firebase-admin/firestore");
  return (by: number) => mod.FieldValue.increment(by);
}

export function loadDefaultClient(): {
  module: ClientFirestoreModule;
  firestore: unknown;
} {
  return {
    module: firestoreClientSdk as unknown as ClientFirestoreModule,
    firestore: getClientFirestore(),
  };
}

export function stripUndefinedDeep(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripUndefinedDeep(entry))
      .filter((entry) => entry !== undefined);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripUndefinedDeep(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

export function extractId<T>(coll: CollectionDef<T>, doc: T): string {
  const raw = doc[coll.idField];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(
      `Document ${coll.name}.${String(coll.idField)} must be a non-empty string; got ${typeof raw === "string" ? `""` : typeof raw}.`,
    );
  }
  return raw;
}

export function toDocKey(id: string): string {
  return encodeURIComponent(id);
}

export function filterEntries<T>(
  filter: Filter<T> | undefined,
): { field: string; value: unknown }[] {
  if (filter === undefined) return [];
  const out: { field: string; value: unknown }[] = [];
  for (const key of Object.keys(filter) as (keyof T)[]) {
    // Skip undefined filter values (consistent with the in-memory adapter):
    // callers spread optional values and expect undefined to mean
    // "not specified", not "match docs whose field is undefined".
    const value = filter[key];
    if (value === undefined) continue;
    out.push({ field: String(key), value });
  }
  return out;
}
