import { describe, expect, it, vi } from "vitest";
import { Collections, createDb, DbAdapterKind } from "@/db";
import { CommandStatus, CommandType, RunStatus } from "@/db/schemas";
import type { CommandListenerHandle } from "@/engine/commands";
import {
  makeCommand,
  makeWorkflowRun,
} from "@/engine/commands/commands-tests/fixtures";
import type { CrashRecoveryReport } from "@/engine/recovery";
import type { SchedulerHandle } from "@/engine/scheduler";
import { DiscoveryPhase } from "@/engine/self-discovery";
import { bootstrapEngine } from "./bootstrap";
import {
  makeBootstrapConfig,
  resolverWithBasePr,
  transportReturning,
} from "./bootstrap-tests/fixtures";
import { makeDiscoveredPr } from "@/engine/enrollment/enrollment-tests/fixtures";

// ---------------------------------------------------------------------------
// Tests for `bootstrapEngine` — the `shepherd start` engine bootstrap (#207).
// These are smoke tests of the boot sequence wiring (config → Db → crash
// recovery → scheduler + commands listener → initial self-discovery pass); the
// lower-level edge cases live in each building block's own spec and are not
// re-tested here. An in-memory `Db` stands in for managed Firestore.
// ---------------------------------------------------------------------------

const emptyRecovery: CrashRecoveryReport = {
  demotedQueuedStepIds: [],
  staleRunningStepIds: [],
  warnedRunningSteps: [],
  failedOrphanRunIds: [],
};

describe("boots the engine from config and runs the building blocks", () => {
  it("wires the pieces and starts the loop without throwing against an in-memory Db", async () => {
    const config = makeBootstrapConfig();

    const handle = await bootstrapEngine({
      transport: transportReturning([]),
      resolveWorkflow: resolverWithBasePr(),
      deps: { loadConfig: () => config },
    });

    expect(handle.config).toBe(config);
    expect(handle.scheduler).toBeDefined();
    expect(handle.commands).toBeDefined();
    handle.stop();
  });

  it("loads config from the configured path before building the Db", async () => {
    const config = makeBootstrapConfig();
    const loadConfig = vi.fn(() => config);

    const handle = await bootstrapEngine({
      configPath: "/etc/shepherd/config.yaml",
      transport: transportReturning([]),
      resolveWorkflow: resolverWithBasePr(),
      deps: { loadConfig },
    });
    handle.stop();

    expect(loadConfig).toHaveBeenCalledWith("/etc/shepherd/config.yaml");
  });

  it("runs crash recovery before starting the scheduler", async () => {
    const order: string[] = [];
    const config = makeBootstrapConfig();

    const handle = await bootstrapEngine({
      transport: transportReturning([]),
      resolveWorkflow: resolverWithBasePr(),
      deps: {
        loadConfig: () => config,
        recoverFromCrash: () => {
          order.push("recover");
          return Promise.resolve(emptyRecovery);
        },
        startScheduler: (): SchedulerHandle => {
          order.push("scheduler");
          return { stop: vi.fn() };
        },
      },
    });
    handle.stop();

    expect(order).toEqual(["recover", "scheduler"]);
  });

  it("enrolls a freshly-discovered PR during the initial self-discovery pass", async () => {
    const config = makeBootstrapConfig();
    const transport = transportReturning([
      makeDiscoveredPr({ number: 42, author: "octocat" }),
    ]);

    const handle = await bootstrapEngine({
      transport,
      resolveWorkflow: resolverWithBasePr(),
      deps: { loadConfig: () => config },
    });

    expect(handle.initialDiscovery.phase).toBe(DiscoveryPhase.Upfront);
    expect(handle.initialDiscovery.enrolled).toHaveLength(1);
    const runs = await handle.db.list(Collections.workflowRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prNumber).toBe(42);
    expect(runs[0]?.status).toBe(RunStatus.Pending);
    handle.stop();
  });
});

describe("structured so the resilience pieces have clear seams", () => {
  it("returns a handle whose stop() halts the scheduler and detaches subscriptions", async () => {
    const config = makeBootstrapConfig();
    const schedulerStop = vi.fn();
    const commandsStop = vi.fn();
    const db = createDb({ adapter: DbAdapterKind.InMemory });
    const closeSubscriptions = vi.spyOn(db, "closeSubscriptions");

    const handle = await bootstrapEngine({
      transport: transportReturning([]),
      resolveWorkflow: resolverWithBasePr(),
      deps: {
        loadConfig: () => config,
        createDb: () => db,
        startScheduler: (): SchedulerHandle => ({ stop: schedulerStop }),
        startCommandListener: (): CommandListenerHandle => ({
          stop: commandsStop,
          drain: () => Promise.resolve(),
        }),
      },
    });

    handle.stop();

    expect(schedulerStop).toHaveBeenCalledOnce();
    expect(commandsStop).toHaveBeenCalledOnce();
    expect(closeSubscriptions).toHaveBeenCalledOnce();
  });

  it("stop() is idempotent — a second call does not re-halt the pieces", async () => {
    const config = makeBootstrapConfig();
    const schedulerStop = vi.fn();

    const handle = await bootstrapEngine({
      transport: transportReturning([]),
      resolveWorkflow: resolverWithBasePr(),
      deps: {
        loadConfig: () => config,
        startScheduler: (): SchedulerHandle => ({ stop: schedulerStop }),
      },
    });

    handle.stop();
    handle.stop();

    expect(schedulerStop).toHaveBeenCalledOnce();
  });
});

describe("processes operator commands through the started listener", () => {
  it("applies a pending command written before boot", async () => {
    const config = makeBootstrapConfig();
    const db = createDb({ adapter: DbAdapterKind.InMemory });

    await db.create(
      Collections.workflowRuns,
      makeWorkflowRun({ id: "run-1", paused: true }),
    );
    await db.create(
      Collections.commands,
      makeCommand({
        id: "cmd-1",
        type: CommandType.ResumeRun,
        payload: { runId: "run-1" },
      }),
    );

    const handle = await bootstrapEngine({
      transport: transportReturning([]),
      resolveWorkflow: resolverWithBasePr(),
      deps: { loadConfig: () => config, createDb: () => db },
    });
    await handle.commands.drain();
    handle.stop();

    const command = await db.get(Collections.commands, "cmd-1");
    expect(command?.status).toBe(CommandStatus.Handled);
    const run = await db.get(Collections.workflowRuns, "run-1");
    expect(run?.paused).toBe(false);
  });
});
