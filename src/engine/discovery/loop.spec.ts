import { describe, it, expect } from "vitest";
import type { Config, RepositoryConfig } from "@/config";
import { DbAdapterKind } from "@/db";
import { startDiscoveryLoop } from "./loop";
import type { DiscoveredPr, PrReadTransport, DiscoverySweep } from "./types";

// ---------------------------------------------------------------------------
// Tests for `startDiscoveryLoop` — the long-running cadence wrapper around the
// per-tick `discoverOpenPrs` sweep. The interval is derived from
// `config.poll.newPrIntervalSeconds` but `sleep` is injectable so tests drive
// the loop without real timers, and the discovered set is handed to the
// `onDiscovered` enrollment hook each tick (issue #125).
// ---------------------------------------------------------------------------

function makeRepositoryConfig(
  overrides: Partial<RepositoryConfig> = {},
): RepositoryConfig {
  return {
    id: "owner/repo",
    enabled: true,
    workflows: [{ match: "*", workflowId: "base-pr" }],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Config["poll"]> = {}): Config {
  return {
    concurrency: { systemMax: 8, githubApiMax: 4, defaultRepoMax: 2 },
    repositories: [makeRepositoryConfig({ id: "acme/alpha" })],
    poll: {
      newPrIntervalSeconds: 60,
      schedulerIntervalSeconds: 5,
      heartbeatIntervalSeconds: 15,
      ...overrides,
    },
    db: { adapter: DbAdapterKind.InMemory, logOverflowPath: "./data/logs" },
    commands: { collectionPath: "commands", pollIntervalSeconds: 5 },
  };
}

function makeDiscoveredPr(overrides: Partial<DiscoveredPr> = {}): DiscoveredPr {
  return {
    repo: "acme/alpha",
    number: 1,
    author: "octocat",
    title: "Add a thing",
    ...overrides,
  };
}

function makeTransport(prs: DiscoveredPr[]): PrReadTransport {
  return { listOpenPrs: () => Promise.resolve(prs) };
}

// A no-op enrollment handler for the interval-only test, where the discovered
// set is irrelevant. Reading the argument keeps it from being a bare empty fn.
function ignoreSweep(_sweep: DiscoverySweep): void {
  void _sweep;
}

// A promise that never settles. Tests inject this as the `sleep` return after
// the first tick so the loop parks until `handle.stop()` ends it — keeping the
// assertion deterministic without relying on real timers.
function neverResolve(): Promise<void> {
  return new Promise<void>(() => {
    // Intentionally never resolved; the loop is stopped via handle.stop().
  });
}

describe("the loop hands the discovered PR set to enrollment each tick", () => {
  it("invokes onDiscovered with the swept PRs and stops cleanly", async () => {
    const config = makeConfig();
    const transport = makeTransport([makeDiscoveredPr({ number: 42 })]);
    const sweeps: DiscoverySweep[] = [];

    // Resolve after the first sleep so the loop runs exactly one tick then
    // parks; stopping before the timer fires keeps the test deterministic.
    let resolveFirstSleep: (() => void) | undefined;
    const firstSleep = new Promise<void>((resolve) => {
      resolveFirstSleep = resolve;
    });
    let sleepCalls = 0;
    const handle = startDiscoveryLoop(config, transport, {
      onDiscovered: (sweep) => {
        sweeps.push(sweep);
      },
      sleep: () => {
        sleepCalls += 1;
        if (sleepCalls === 1) {
          resolveFirstSleep?.();
        }
        // Park forever after the first tick; handle.stop() ends the loop.
        return neverResolve();
      },
    });

    await firstSleep;
    handle.stop();

    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]?.discovered).toEqual([makeDiscoveredPr({ number: 42 })]);
  });
});

describe("the loop derives its interval from poll.newPrIntervalSeconds", () => {
  it("sleeps for the configured interval in milliseconds", async () => {
    const config = makeConfig({ newPrIntervalSeconds: 90 });
    const transport = makeTransport([]);
    const sleptMs: number[] = [];

    let resolveSeen: (() => void) | undefined;
    const seen = new Promise<void>((resolve) => {
      resolveSeen = resolve;
    });
    const handle = startDiscoveryLoop(config, transport, {
      onDiscovered: ignoreSweep,
      sleep: (ms: number) => {
        sleptMs.push(ms);
        resolveSeen?.();
        return neverResolve();
      },
    });

    await seen;
    handle.stop();

    expect(sleptMs[0]).toBe(90_000);
  });
});

describe("an onDiscovered handler throw does not crash the loop", () => {
  it("routes the error to onTickError and keeps running", async () => {
    const config = makeConfig();
    const transport = makeTransport([makeDiscoveredPr()]);
    const errors: unknown[] = [];

    let resolveErr: (() => void) | undefined;
    const sawError = new Promise<void>((resolve) => {
      resolveErr = resolve;
    });
    const handle = startDiscoveryLoop(config, transport, {
      onDiscovered: () => {
        throw new Error("enrollment exploded");
      },
      onTickError: (err) => {
        errors.push(err);
        resolveErr?.();
      },
      sleep: () => neverResolve(),
    });

    await sawError;
    handle.stop();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("enrollment exploded");
  });
});
