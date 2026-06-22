import { loadConfig as loadConfigDefault } from "@/config";
import { createDb as createDbDefault } from "@/db";
import type { Config } from "@/config";
import type { Db } from "@/db/types";
import { startCommandListener } from "@/engine/commands";
import { recoverFromCrash } from "@/engine/recovery/startup";
import { startScheduler } from "@/engine/scheduler/loop";
import { DiscoveryPhase, runSelfDiscoveryPass } from "@/engine/self-discovery";
import { createDiskWorkflowResolver } from "./resolveWorkflow";
import type { BootstrapDeps, BootstrapOptions, DaemonHandle } from "./types";

// ---------------------------------------------------------------------------
// Engine bootstrap (issue #207) — the keystone of Epic 6.
//
// `bootstrapEngine` boots the **headless** daemon: it runs purely as a
// background process with no HTTP surface and no port. On `shepherd start` it
// performs the boot sequence:
//
//   1. loadConfig      — read + validate `config.yaml`.
//   2. createDb        — construct the admin-SDK Firestore `Db` from config.
//   3. recoverFromCrash — reconcile state a previous crash left behind, BEFORE
//                         the scheduler is allowed to admit work.
//   4. startScheduler  — begin the tick loop on the configured cadence.
//   5. startCommandListener — attach the operator → daemon control plane.
//   6. runSelfDiscoveryPass — enroll the configured repos' open PRs upfront.
//
// Every collaborator is reached through `BootstrapDeps`, defaulted here to the
// production implementation, so the whole sequence is unit-testable against an
// in-memory `Db` and Epic 11's orchestration/resilience pieces (drain loop,
// wait-set, circuit breakers) have explicit seams to substitute. The returned
// `DaemonHandle.stop()` is the clean seam graceful shutdown (#208) drains
// in-flight steps through; today it halts the running pieces and detaches every
// subscription, idempotently.
// ---------------------------------------------------------------------------

function resolveDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    loadConfig: (configPath) => loadConfigDefault(configPath),
    createDb: (config) =>
      createDbDefault({
        adapter: config.db.adapter,
        emulator: config.db.emulator,
      }),
    recoverFromCrash: (db) => recoverFromCrash(db),
    startScheduler: (db, config) =>
      startScheduler(
        db,
        { concurrency: config.concurrency },
        { intervalMs: config.poll.schedulerIntervalSeconds * 1000 },
      ),
    startCommandListener: (db, config) =>
      startCommandListener(db, {
        collectionPath: config.commands.collectionPath,
      }),
    runSelfDiscoveryPass: (db, config, transport, resolveWorkflow) =>
      runSelfDiscoveryPass(db, config, {
        transport,
        resolveWorkflow,
        phase: DiscoveryPhase.Upfront,
      }),
    ...overrides,
  };
}

export async function bootstrapEngine(
  options: BootstrapOptions,
): Promise<DaemonHandle> {
  const deps = resolveDeps(options.deps);
  const resolveWorkflow =
    options.resolveWorkflow ?? createDiskWorkflowResolver();

  const config: Config = deps.loadConfig(options.configPath);
  const db: Db = deps.createDb(config);

  // Crash recovery runs before the scheduler so it never races a tick over
  // steps a previous process left mid-flight.
  const crashRecovery = await deps.recoverFromCrash(db);

  const scheduler = deps.startScheduler(db, config);
  const commands = deps.startCommandListener(db, config);

  // Enroll the configured repos' open PRs upfront. Subsequent passes are the
  // drain loop's responsibility (#208 / Epic 11); this is the initial sweep so
  // the daemon has work the moment it starts.
  const initialDiscovery = await deps.runSelfDiscoveryPass(
    db,
    config,
    options.transport,
    resolveWorkflow,
  );

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    scheduler.stop();
    commands.stop();
    db.closeSubscriptions();
  };

  return {
    db,
    config,
    scheduler,
    commands,
    crashRecovery,
    initialDiscovery,
    stop,
  };
}
