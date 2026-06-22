import { bootstrapEngine } from "@/engine/bootstrap";
import type { DaemonHandle } from "@/engine/bootstrap";
import type { PrReadTransport } from "@/engine/discovery";

// Handler for `shepherd start` — the keystone of Epic 6 (#207).
//
// Boots the **headless** daemon: load config → construct the admin-SDK
// Firestore `Db` → run crash recovery → start the scheduler + commands
// listener → run an initial self-discovery pass. There is no HTTP server and
// no port — the process runs purely in the background, and the Vercel UI
// reaches its state through Firestore directly (ARCHITECTURE.md topology).
//
// `bootstrapEngine` owns the wiring; this handler supplies the read-side PR
// transport and keeps the returned `DaemonHandle` alive. Graceful shutdown —
// SIGTERM draining in-flight steps before exit — is the stacked follow-up
// (#208); this handler leaves a clean seam by holding the handle (whose
// `stop()` that issue drives the drain through) rather than implementing the
// drain here.

// The live PR-read transport (`listOpenPrs`) is the webhook/poll read side
// landing in Epic 12. Until it merges, the daemon boots with an empty-sweep
// transport: the initial self-discovery pass runs cleanly (enrolling nothing)
// so the boot sequence is exercised end to end, and a one-line warning makes
// the absence explicit rather than silently swallowed. Swap this for the real
// transport when it lands — no other wiring changes.
function emptySweepTransport(): PrReadTransport {
  console.warn(
    "[shepherd start] no PR-read transport wired yet (Epic 12); " +
      "self-discovery will enroll no PRs until it lands.",
  );
  return { listOpenPrs: () => Promise.resolve([]) };
}

// The live daemon handle, exported so the process keeps a reference to it (and
// therefore its subscriptions) while it runs. Graceful shutdown (#208) reads
// this from its SIGTERM handler to drive the in-flight-step drain through
// `handle.stop()`.
export let daemon: DaemonHandle | undefined;

export async function runStart(): Promise<void> {
  daemon = await bootstrapEngine({ transport: emptySweepTransport() });
}
