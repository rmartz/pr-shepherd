import { describe, it, expect } from "vitest";
import type { Config, RepositoryConfig } from "@/config";
import { DbAdapterKind } from "@/db";
import { discoverOpenPrs } from "./discover";
import type { DiscoveredPr, PrReadTransport } from "./types";

// ---------------------------------------------------------------------------
// Tests for `discoverOpenPrs` — the single-pass sweep that lists open PRs for
// every enabled repository in the daemon `Config`. The sweep consumes the
// typed `Config` (repositories + their `enabled` flag) and an injected
// `PrReadTransport` so no real network is touched in tests (issue #125).
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

function makeConfig(repositories: RepositoryConfig[]): Config {
  return {
    concurrency: { systemMax: 8, githubApiMax: 4, defaultRepoMax: 2 },
    repositories,
    poll: {
      newPrIntervalSeconds: 60,
      reconcileIntervalSeconds: 5,
      heartbeatIntervalSeconds: 15,
    },
    db: { adapter: DbAdapterKind.InMemory, logOverflowPath: "./data/logs" },
    commands: { collectionPath: "commands", pollIntervalSeconds: 5 },
  };
}

function makeDiscoveredPr(overrides: Partial<DiscoveredPr> = {}): DiscoveredPr {
  return {
    repo: "owner/repo",
    number: 1,
    author: "octocat",
    title: "Add a thing",
    ...overrides,
  };
}

// A transport whose responses are scripted per-repo. A repo whose id maps to
// an Error rejects, exercising the fail-open path.
function makeScriptedTransport(
  byRepo: Record<string, DiscoveredPr[] | Error>,
): PrReadTransport {
  return {
    listOpenPrs: (repoId: string) => {
      const scripted = byRepo[repoId];
      if (scripted instanceof Error) return Promise.reject(scripted);
      return Promise.resolve(scripted ?? []);
    },
  };
}

describe("discovers open PRs for each enabled repo on the configured interval", () => {
  it("aggregates PRs across two repos via the injected transport", async () => {
    const config = makeConfig([
      makeRepositoryConfig({ id: "acme/alpha" }),
      makeRepositoryConfig({ id: "acme/beta" }),
    ]);
    const transport = makeScriptedTransport({
      "acme/alpha": [
        makeDiscoveredPr({ repo: "acme/alpha", number: 11, author: "ann" }),
      ],
      "acme/beta": [
        makeDiscoveredPr({ repo: "acme/beta", number: 22, author: "bob" }),
        makeDiscoveredPr({ repo: "acme/beta", number: 23, author: "cleo" }),
      ],
    });

    const result = await discoverOpenPrs(config, transport);

    expect(result.discovered).toEqual([
      makeDiscoveredPr({ repo: "acme/alpha", number: 11, author: "ann" }),
      makeDiscoveredPr({ repo: "acme/beta", number: 22, author: "bob" }),
      makeDiscoveredPr({ repo: "acme/beta", number: 23, author: "cleo" }),
    ]);
    expect(result.errors).toEqual([]);
  });
});

describe("disabled repos are skipped", () => {
  it("never queries the transport for a disabled repo", async () => {
    const queried: string[] = [];
    const config = makeConfig([
      makeRepositoryConfig({ id: "acme/on", enabled: true }),
      makeRepositoryConfig({ id: "acme/off", enabled: false }),
    ]);
    const transport: PrReadTransport = {
      listOpenPrs: (repoId: string) => {
        queried.push(repoId);
        return Promise.resolve([makeDiscoveredPr({ repo: repoId, number: 7 })]);
      },
    };

    const result = await discoverOpenPrs(config, transport);

    expect(queried).toEqual(["acme/on"]);
    expect(result.discovered).toEqual([
      makeDiscoveredPr({ repo: "acme/on", number: 7 }),
    ]);
  });
});

describe("the sweep is resilient to a per-repo transport error (fail open)", () => {
  it("continues other repos and records the failing repo's error", async () => {
    const config = makeConfig([
      makeRepositoryConfig({ id: "acme/good" }),
      makeRepositoryConfig({ id: "acme/bad" }),
    ]);
    const transport = makeScriptedTransport({
      "acme/good": [makeDiscoveredPr({ repo: "acme/good", number: 99 })],
      "acme/bad": new Error("gh: rate limited"),
    });

    const result = await discoverOpenPrs(config, transport);

    expect(result.discovered).toEqual([
      makeDiscoveredPr({ repo: "acme/good", number: 99 }),
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.repo).toBe("acme/bad");
    expect(result.errors[0]?.message).toContain("rate limited");
  });
});
