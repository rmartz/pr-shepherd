import type {
  CollectionDef,
  Filter,
  SubscriptionCallback,
  Unsubscribe,
} from "../types";
import type { AdminFirestoreLike, AdminQuery } from "./firestoreAdminTypes";

// ---------------------------------------------------------------------------
// Daemon-side (admin SDK) realtime subscriptions.
//
// The hosted adapter's client-SDK `subscribe()` is rules-gated and only
// serves the Vercel UI. The daemon runs with service-account credentials and
// must react to writes the instant they land — a user pausing a PR from the
// UI (a `commands` write), a `stepInstances` transition, a derivation
// trigger. This manager wraps the admin SDK's `Query.onSnapshot` so the
// daemon gets the same push-style updates without the rules gate.
//
// Three responsibilities beyond a bare `onSnapshot` wrap:
//   - **Lifecycle**: each subscribe returns an idempotent `Unsubscribe` that
//     detaches the live listener; `closeAll()` detaches every active listener
//     so the daemon can release them on graceful shutdown.
//   - **Resilience**: a transient stream error (`onError`) tears the listener
//     down — the admin SDK guarantees no further callbacks after it fires — so
//     the manager re-attaches with exponential backoff until it recovers or
//     the caller unsubscribes.
//   - **Decoding**: every document is parsed through the collection's Zod
//     schema, mirroring the CRUD path, so subscribers receive typed docs.
// ---------------------------------------------------------------------------

const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export interface AdminSubscriptionManagerOptions {
  // Resolves the admin Firestore handle. Async because production loads
  // `firebase-admin` via a lazy dynamic import; tests resolve a fake handle.
  loadAdmin: () => Promise<AdminFirestoreLike>;
  // Initial re-subscribe delay after a transient error. Doubles each
  // consecutive failure up to `maxBackoffMs`. Injectable for tests.
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  // Injected for deterministic tests. Default to the global timer functions.
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

// One live subscription's mutable state. `detach` is replaced on every
// (re)attach so `unsubscribe` always tears down the current listener.
// `attempt` is the consecutive-failure count that drives backoff; it lives
// here (not as an `attach` closure parameter) so `onNext` can reset it to 0
// once a snapshot arrives — an intermittent stream then restarts from the base
// delay instead of ratcheting up across the daemon's lifetime.
interface ActiveSubscription {
  cancelled: boolean;
  detach: (() => void) | undefined;
  backoffTimer: ReturnType<typeof setTimeout> | undefined;
  attempt: number;
}

// Read `cancelled` through a function so TypeScript's control-flow analysis
// does not narrow a later read to an earlier literal across an `await` — the
// flag is mutated asynchronously by `unsubscribe`/`closeAll`.
function isCancelled(sub: ActiveSubscription): boolean {
  return sub.cancelled;
}

export class AdminSubscriptionManager {
  private readonly loadAdmin: () => Promise<AdminFirestoreLike>;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly setTimer: (
    cb: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private readonly active = new Set<ActiveSubscription>();

  constructor(opts: AdminSubscriptionManagerOptions) {
    this.loadAdmin = opts.loadAdmin;
    this.baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer =
      opts.clearTimer ??
      ((h) => {
        clearTimeout(h);
      });
  }

  subscribe<T>(
    coll: CollectionDef<T>,
    filter: Filter<T> | undefined,
    onChange: SubscriptionCallback<T>,
  ): Unsubscribe {
    const sub: ActiveSubscription = {
      cancelled: false,
      detach: undefined,
      backoffTimer: undefined,
      attempt: 0,
    };
    this.active.add(sub);

    // Attach asynchronously: the admin handle loads via dynamic import in
    // production. `sub.attempt` tracks consecutive failures for backoff and is
    // reset to 0 once a snapshot arrives, so an intermittent stream doesn't
    // ratchet the delay up permanently.
    const attach = async (): Promise<void> => {
      if (isCancelled(sub)) return;
      let admin: AdminFirestoreLike;
      try {
        admin = await this.loadAdmin();
      } catch {
        this.scheduleRetry(sub, attach);
        return;
      }
      // Re-check after the async load: `unsubscribe`/`closeAll` may have
      // flipped `cancelled` while the admin handle was resolving. Read through
      // a helper so flow analysis doesn't narrow the post-await value to the
      // pre-await literal.
      if (isCancelled(sub)) return;
      const query = this.buildQuery(admin, coll, filter);
      sub.detach = query.onSnapshot(
        (snap) => {
          // A snapshot proves the stream is healthy, so clear the failure
          // count: a later transient drop restarts from the base delay rather
          // than the ratcheted-up one.
          sub.attempt = 0;
          onChange(snap.docs.map((d) => coll.schema.parse(d.data())));
        },
        () => {
          // The admin SDK guarantees no further callbacks on this listener
          // after `onError`. Drop the dead handle and re-attach with backoff.
          sub.detach = undefined;
          if (sub.cancelled) return;
          sub.attempt += 1;
          this.scheduleRetry(sub, attach);
        },
      );
    };

    void attach();

    return () => {
      if (sub.cancelled) return;
      sub.cancelled = true;
      this.teardown(sub);
      this.active.delete(sub);
    };
  }

  // Detach every live listener. The daemon calls this on graceful shutdown so
  // no Firestore stream outlives the process intent. Subscriptions are marked
  // cancelled so any in-flight backoff retry is a no-op.
  closeAll(): void {
    for (const sub of [...this.active]) {
      sub.cancelled = true;
      this.teardown(sub);
    }
    this.active.clear();
  }

  private buildQuery<T>(
    admin: AdminFirestoreLike,
    coll: CollectionDef<T>,
    filter: Filter<T> | undefined,
  ): AdminQuery {
    let query: AdminQuery = admin.collection(coll.name);
    if (filter !== undefined) {
      for (const key of Object.keys(filter) as (keyof T)[]) {
        // Skip undefined filter values, consistent with the CRUD path: a
        // spread optional means "not specified", not "field is undefined".
        const value = filter[key];
        if (value === undefined) continue;
        query = query.where(String(key), "==", value);
      }
    }
    return query;
  }

  private scheduleRetry(
    sub: ActiveSubscription,
    attach: () => Promise<void>,
  ): void {
    if (sub.cancelled) return;
    const delay = Math.min(
      this.baseBackoffMs * 2 ** Math.max(0, sub.attempt - 1),
      this.maxBackoffMs,
    );
    sub.backoffTimer = this.setTimer(() => {
      sub.backoffTimer = undefined;
      void attach();
    }, delay);
  }

  private teardown(sub: ActiveSubscription): void {
    if (sub.backoffTimer !== undefined) {
      this.clearTimer(sub.backoffTimer);
      sub.backoffTimer = undefined;
    }
    if (sub.detach !== undefined) {
      sub.detach();
      sub.detach = undefined;
    }
  }
}
