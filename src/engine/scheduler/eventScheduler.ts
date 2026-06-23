import { Collections } from "@/db/collections";
import { StepStatus } from "@/db/schemas";
import type { Db, Unsubscribe } from "@/db/types";
import { runSchedulerTick, type SchedulerConfig } from "./loop";
import type { SchedulerTickReport } from "./loop";

// ---------------------------------------------------------------------------
// Event-driven scheduler (#120, vision §8 — polling → webhooks).
//
// `runSchedulerTick` (loop.ts) is the single-pass admission unit. This module
// wraps it in a long-running daemon that ticks the *instant* relevant state
// changes — a pending `stepInstance` write, a UI command, a webhook-driven
// derivation trigger — via the daemon Firestore subscriptions from #119,
// while keeping a low-frequency reconciliation poll as a safety net.
//
// Latency comes from push; correctness comes from the poll. This layering is
// safe because the tick re-derives concurrency counts fresh each run
// (restart-safe): events are a *trigger*, never a source of truth, so an
// out-of-order, duplicated, or dropped event cannot corrupt admission. The
// poll covers missed/dropped listener events and crash windows ("fail open").
//
// Triggers are debounced so an event storm collapses to a single tick rather
// than one tick per event, and a trigger arriving while a tick is in flight
// is coalesced into one follow-up tick instead of racing it.
// ---------------------------------------------------------------------------

// A trigger source wires a single Db subscription to the scheduler's trigger
// callback. Returning the thunk (rather than a {collection, filter} pair)
// keeps each source's document type intact at the call site — the array of
// sources stays heterogeneous without erasing types to `unknown`.
export type TriggerSubscription = (
  db: Db,
  onTrigger: () => void,
) => Unsubscribe;

// Default trigger: any change to the set of pending step instances. New work
// (a freshly-created step) and capacity-freeing transitions both surface here,
// so this alone keeps admission latency low. Additional sources — UI commands,
// webhook-derived triggers — plug in via `options.triggers` once those
// collections exist (#111, UI command channel).
export const pendingStepInstancesTrigger: TriggerSubscription = (
  db,
  onTrigger,
) =>
  db.subscribe(
    Collections.stepInstances,
    { status: StepStatus.Pending },
    () => {
      onTrigger();
    },
  );

// Injectable one-shot timer primitives. Default to the host timers; tests
// supply a fake registry to fire timers deterministically. The handle is
// opaque (`unknown`) so any timer implementation fits.
export interface SchedulerTimers {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface SchedulerHandle {
  // Detaches every subscription, cancels pending timers, and resolves once the
  // in-flight tick (if any) has drained.
  stop: () => Promise<void>;
}

export interface StartSchedulerOptions {
  // Low-frequency reconciliation poll — the safety net. Kept much higher than
  // the old fixed cadence: push handles latency, so the poll only needs to
  // catch dropped events and crash windows.
  reconcileIntervalMs: number;
  // Window over which a burst of triggers collapses to a single tick.
  debounceMs?: number;
  // Trigger sources. Defaults to pending step instances.
  triggers?: TriggerSubscription[];
  onTick?: (report: SchedulerTickReport | undefined) => void;
  onTickError?: (err: unknown) => void;
  timers?: SchedulerTimers;
}

const DEFAULT_DEBOUNCE_MS = 50;

const hostTimers: SchedulerTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function startScheduler(
  db: Db,
  config: SchedulerConfig,
  options: StartSchedulerOptions,
): SchedulerHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const timers = options.timers ?? hostTimers;
  const triggers = options.triggers ?? [pendingStepInstancesTrigger];

  let running = true;
  let ticking = false;
  let coalesced = false; // a trigger arrived while a tick was in flight
  let debounceHandle: unknown;
  let reconcileHandle: unknown;
  let inFlight: Promise<void> = Promise.resolve();

  // One admission pass; a thrown tick (Db hiccup) or onTick hook must not crash
  // the daemon, so failures are surfaced to the handler and swallowed.
  const runTick = async (): Promise<void> => {
    try {
      options.onTick?.(await runSchedulerTick(db, config));
    } catch (err) {
      options.onTickError?.(err);
    }
  };

  // Run a tick, then — if a trigger arrived mid-flight — drain it as a single
  // follow-up pass (the recursion). Never runs two ticks concurrently, which is
  // what keeps the fresh-count derivation in `runSchedulerTick` race-free. The
  // `coalesced` reset lives in the caller and in the recursion's own branch, not
  // before the read, so it reflects only triggers seen during `runTick`.
  const drain = async (): Promise<void> => {
    await runTick();
    if (running && coalesced) {
      coalesced = false;
      await drain();
      return;
    }
    ticking = false;
  };

  const fireTick = (): void => {
    if (ticking) {
      coalesced = true;
      return;
    }
    ticking = true;
    coalesced = false;
    inFlight = drain();
  };

  // Debounce: each trigger resets the timer, so a storm collapses to one tick.
  const trigger = (): void => {
    if (!running) return;
    if (debounceHandle !== undefined) timers.clearTimer(debounceHandle);
    debounceHandle = timers.setTimer(() => {
      debounceHandle = undefined;
      fireTick();
    }, debounceMs);
  };

  // Reconciliation poll: a self-re-arming one-shot that ticks regardless of
  // whether any event fired, covering dropped listener events and crash gaps.
  const scheduleReconcile = (): void => {
    reconcileHandle = timers.setTimer(() => {
      if (!running) return;
      fireTick();
      scheduleReconcile();
    }, options.reconcileIntervalMs);
  };

  const unsubscribes = triggers.map((t) => t(db, trigger));
  scheduleReconcile();

  return {
    stop: async () => {
      running = false;
      if (debounceHandle !== undefined) timers.clearTimer(debounceHandle);
      if (reconcileHandle !== undefined) timers.clearTimer(reconcileHandle);
      for (const unsubscribe of unsubscribes) unsubscribe();
      await inFlight;
    },
  };
}
