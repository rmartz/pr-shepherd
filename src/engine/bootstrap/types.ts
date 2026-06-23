import type { Config } from "@/config";
import type { Db } from "@/db/types";
import type { PrReadTransport } from "@/engine/discovery";
import type { WorkflowResolver } from "@/engine/enrollment";
import type { CommandListenerHandle } from "@/engine/commands";
import type { CrashRecoveryReport } from "@/engine/recovery/startup";
import type { SchedulerHandle } from "@/engine/scheduler";
import type { SelfDiscoveryReport } from "@/engine/self-discovery";

// ---------------------------------------------------------------------------
// Engine-bootstrap contracts (issue #207).
//
// `bootstrapEngine` is the keystone of Epic 6: it turns the merged building
// blocks (config loader, admin-SDK Db factory, crash recovery, scheduler,
// commands listener, self-discovery) into a single running **headless** daemon
// — no HTTP server, no port.
//
// Every collaborator the bootstrap touches is reachable through `BootstrapDeps`
// so the sequence is unit-testable against an in-memory `Db` without spinning a
// real daemon, and so Epic 11's orchestration/resilience pieces (drain loop,
// wait-set, circuit breakers) have explicit seams to substitute. Production
// callers (`shepherd start`) rely on the defaults; tests inject fakes.
// ---------------------------------------------------------------------------

// The read-side transport the self-discovery sweep lists open PRs through.
// Production wires the real `gh`-CLI / GitHub-MCP transport (Epic 12); the
// bootstrap requires it as an injected seam because no production transport
// has landed yet, keeping this issue free of a half-built network dependency.
export type { PrReadTransport, WorkflowResolver };

// Injectable collaborators. Each defaults to the production implementation in
// `bootstrapEngine`; tests override the ones they need to observe or stub.
export interface BootstrapDeps {
  // Reads, parses, and validates `config.yaml`. Defaults to the config loader.
  loadConfig: (configPath: string | undefined) => Config;
  // Constructs the admin-SDK `Db` from the resolved config. Defaults to the
  // `createDb` factory keyed on `config.db.adapter`.
  createDb: (config: Config) => Db;
  // Reconciles state left behind by a previous crash before the scheduler is
  // allowed to admit work. Defaults to `recoverFromCrash`.
  recoverFromCrash: (db: Db) => Promise<CrashRecoveryReport>;
  // Starts the scheduler tick loop. Defaults to `startScheduler`. Returns a
  // handle whose `stop()` the daemon handle composes for the #208 drain seam.
  startScheduler: (db: Db, config: Config) => SchedulerHandle;
  // Starts the operator → daemon commands listener. Defaults to
  // `startCommandListener`, bound to `config.commands.collectionPath`.
  startCommandListener: (db: Db, config: Config) => CommandListenerHandle;
  // Runs one self-discovery / enrollment pass. Defaults to
  // `runSelfDiscoveryPass` tagged `Upfront`. Requires `transport` +
  // `resolveWorkflow` from `BootstrapOptions`.
  runSelfDiscoveryPass: (
    db: Db,
    config: Config,
    transport: PrReadTransport,
    resolveWorkflow: WorkflowResolver,
  ) => Promise<SelfDiscoveryReport>;
}

export interface BootstrapOptions {
  // Path to `config.yaml`. `undefined` defers to the loader's default
  // (`config.yaml` relative to the process working directory).
  configPath?: string;
  // The read-side transport for the initial self-discovery sweep. Required:
  // no production transport has landed yet, so the daemon entrypoint owns
  // constructing one. Tests inject a scripted fake.
  transport: PrReadTransport;
  // Resolves a matched `workflowId` to its loaded graph. Defaults to the
  // disk-backed resolver (`workflows/<id>.yaml`) when omitted.
  resolveWorkflow?: WorkflowResolver;
  // Partial dependency overrides for testing. Any key omitted falls back to
  // the production default.
  deps?: Partial<BootstrapDeps>;
}

// Returned by `bootstrapEngine`. Holds the live collaborators and the
// initial-pass reports so the caller can log them, and exposes `stop()` — the
// clean seam graceful shutdown (#208) drives the SIGTERM drain through. `stop`
// is idempotent: it detaches every subscription and halts the scheduler once.
export interface DaemonHandle {
  db: Db;
  config: Config;
  scheduler: SchedulerHandle;
  commands: CommandListenerHandle;
  crashRecovery: CrashRecoveryReport;
  initialDiscovery: SelfDiscoveryReport;
  // Halt the daemon's running pieces and detach every Db subscription. The
  // in-flight-step drain (#208) wraps this; today it stops cleanly.
  stop: () => void;
}
