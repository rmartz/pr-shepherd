import type { Config } from "@/config";
import { discoverOpenPrs } from "./discover";
import type { DiscoverySweep, PrReadTransport } from "./types";

// ---------------------------------------------------------------------------
// `startDiscoveryLoop` — the long-running cadence wrapper around the per-tick
// `discoverOpenPrs` sweep (issue #125). It mirrors the engine's existing
// `startScheduler` shape: a thin `while (running)` loop with an injectable
// `sleep` so tests advance it without real timers, and per-tick hooks so the
// daemon can survive a transient failure instead of crashing.
//
// The interval is derived from `config.poll.newPrIntervalSeconds` (converted
// to milliseconds). Each tick runs one sweep and hands the discovered PR set
// to `onDiscovered`, which is enrollment's entry point (a separate sub-issue).
// A throw from the sweep or from `onDiscovered` is routed to `onTickError`;
// the loop continues so one bad tick does not stop discovery.
// ---------------------------------------------------------------------------

export interface DiscoveryHandle {
  stop: () => void;
}

export interface StartDiscoveryLoopOptions {
  // Enrollment entry point: receives the discovered PR set (and tolerated
  // per-repo errors) after every sweep.
  onDiscovered: (sweep: DiscoverySweep) => void;
  // Injectable for tests; defaults to a setTimeout-backed sleep.
  sleep?: (ms: number) => Promise<void>;
  // Receives any error thrown during a tick (sweep or `onDiscovered`) so a
  // transient failure does not crash the daemon.
  onTickError?: (err: unknown) => void;
}

const MS_PER_SECOND = 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function startDiscoveryLoop(
  config: Config,
  transport: PrReadTransport,
  options: StartDiscoveryLoopOptions,
): DiscoveryHandle {
  const sleep = options.sleep ?? defaultSleep;
  const intervalMs = config.poll.newPrIntervalSeconds * MS_PER_SECOND;
  let running = true;

  const loop = async (): Promise<void> => {
    while (running) {
      try {
        const sweep = await discoverOpenPrs(config, transport);
        options.onDiscovered(sweep);
      } catch (err) {
        // A throw from the sweep or the `onDiscovered` enrollment hook must
        // not crash the daemon. The loop survives and surfaces the error to
        // the configured handler.
        options.onTickError?.(err);
      }
      // `running` is mutated externally by `handle.stop()`; the next
      // `while (running)` check after sleep is what exits the loop. We sleep
      // unconditionally so the loop stays trivially analyzable, matching the
      // scheduler loop's structure (one extra interval delay on shutdown).
      await sleep(intervalMs);
    }
  };

  void loop();

  return {
    stop: () => {
      running = false;
    },
  };
}
