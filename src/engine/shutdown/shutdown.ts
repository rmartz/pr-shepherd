import { Collections } from "@/db/collections";
import { StepStatus } from "@/db/schemas";
import type { DaemonHandle } from "@/engine/bootstrap";

// ---------------------------------------------------------------------------
// Graceful shutdown (issue #208).
//
// On SIGTERM/SIGINT the daemon must stop taking new work, let in-flight steps
// settle, then exit — without ever hanging. The sequence:
//
//   1. Halt the scheduler so no further `pending` steps are admitted.
//   2. Drain: poll for `running` step instances until none remain, bounded by
//      a configurable grace period.
//   3. Full teardown via `DaemonHandle.stop()` (detaches subscriptions).
//   4. Exit 0 when drained clean, non-zero when the grace elapsed with work
//      still in flight (a hard exit, so shutdown is always bounded).
//
// Cancellation of a running step is owned by its executor's own abort seam
// (e.g. the `claude_skill` SIGTERM→SIGKILL grace path); this orchestrator waits
// for those to settle rather than hard-killing them. The per-step abort wiring
// is driven by the dispatch/worker loop (Epic 11); until that lands, the drain
// is the bounded settle-and-exit guarantee.
// ---------------------------------------------------------------------------

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export interface GracefulShutdownOptions {
  // How long to wait for in-flight steps to settle before a hard exit.
  drainTimeoutMs?: number;
  // How often to recheck the in-flight count while draining.
  pollIntervalMs?: number;
  // Clock + sleep seams (injected in tests so no real time passes).
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // Called once with the exit code (0 = clean drain, 1 = grace elapsed with
  // steps still running). Injected so tests don't terminate the process;
  // defaults to `process.exit`.
  onExit?: (code: number) => void;
}

export interface GracefulShutdownResult {
  drained: boolean; // no `running` steps remained at exit
  remaining: number; // `running` steps still present at exit
  exitCode: number;
}

async function countRunning(handle: DaemonHandle): Promise<number> {
  const running = await handle.db.list(Collections.stepInstances, {
    status: StepStatus.Running,
  });
  return running.length;
}

// Stop admitting work, drain in-flight steps within a bounded grace period,
// tear the daemon down, and exit. Resolves after `onExit` is invoked (returning
// the result for tests; in production `onExit` is `process.exit`).
export async function gracefulShutdown(
  handle: DaemonHandle,
  options: GracefulShutdownOptions = {},
): Promise<GracefulShutdownResult> {
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const onExit = options.onExit ?? ((code: number) => process.exit(code));

  // 1. Stop admitting new steps — the scheduler's next tick won't run.
  handle.scheduler.stop();

  // 2. Drain in-flight (`running`) steps, bounded by the grace period.
  const deadline = now() + drainTimeoutMs;
  let remaining = await countRunning(handle);
  while (remaining > 0 && now() < deadline) {
    await sleep(pollIntervalMs);
    remaining = await countRunning(handle);
  }

  // 3. Full teardown (idempotent: detaches subscriptions, re-stops scheduler).
  handle.stop();

  // 4. Bounded exit.
  const drained = remaining === 0;
  const exitCode = drained ? 0 : 1;
  onExit(exitCode);
  return { drained, remaining, exitCode };
}

// Register SIGTERM/SIGINT handlers that run `gracefulShutdown` once (repeat
// signals during shutdown are ignored). Returns a cleanup that removes the
// listeners (used in tests and on a clean stop).
export function installShutdownHandlers(
  handle: DaemonHandle,
  options: GracefulShutdownOptions = {},
): () => void {
  let shuttingDown = false;
  const onSignal = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void gracefulShutdown(handle, options);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  return () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
}
