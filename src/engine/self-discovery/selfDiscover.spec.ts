import { describe, expect, it, vi } from "vitest";
import type { Config, WorkflowGraph } from "@/config";
import { Collections, createDb, DbAdapterKind } from "@/db";
import type { Db } from "@/db/types";
import type { DiscoveredPr, PrReadTransport } from "@/engine/discovery";
import { SkipReason } from "@/engine/enrollment";
import {
  makeConfig,
  makeDiscoveredPr,
  makeRepositoryConfig,
  makeWorkflowGraph,
} from "@/engine/enrollment/enrollment-tests/fixtures";
import { DiscoveryPhase, runSelfDiscoveryPass } from "./selfDiscover";

// ---------------------------------------------------------------------------
// Tests for `runSelfDiscoveryPass` — the self-discovery integration (#108)
// that recomputes the routable PR set from live state each cycle and enrolls
// newly-eligible PRs idempotently. These are smoke tests of the discover →
// match → enroll → log orchestration; the lower-level edge cases (per-repo
// fail-open sweeps, match precedence, the idempotency key) are owned by the
// discovery (#125) and enrollment (#126) module specs and are not re-tested.
// ---------------------------------------------------------------------------

function freshDb(): Db {
  return createDb({ adapter: DbAdapterKind.InMemory });
}

// A transport whose sweep returns a fixed set of open PRs, with no per-repo
// errors. `listOpenPrs` filters the scripted PRs to the requested repo so a
// multi-repo config sees only its own PRs.
function transportReturning(prs: DiscoveredPr[]): PrReadTransport {
  return {
    listOpenPrs: (repoId) =>
      Promise.resolve(prs.filter((pr) => pr.repo === repoId)),
  };
}

function resolverFor(
  graphs: WorkflowGraph[],
): (id: string) => WorkflowGraph | undefined {
  const byId = new Map(graphs.map((g) => [g.id, g]));
  return (id) => byId.get(id);
}

function configWithBasePr(): Config {
  return makeConfig([
    makeRepositoryConfig({
      workflows: [{ match: "*", workflowId: "base-pr" }],
    }),
  ]);
}

describe("recomputes the routable set and enrolls newly-discovered PRs", () => {
  it("enrolls a run for a freshly-discovered PR", async () => {
    const db = freshDb();
    const transport = transportReturning([
      makeDiscoveredPr({ number: 42, author: "octocat" }),
    ]);

    const report = await runSelfDiscoveryPass(db, configWithBasePr(), {
      transport,
      resolveWorkflow: resolverFor([makeWorkflowGraph({ id: "base-pr" })]),
    });

    expect(report.enrolled).toHaveLength(1);
    expect(report.enrolled[0]?.created).toBe(true);
    expect(report.enrolled[0]?.workflowId).toBe("base-pr");
    const runs = await db.list(Collections.workflowRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prNumber).toBe(42);
  });

  it("recomputes from live transport state each pass rather than a stored list", async () => {
    const db = freshDb();
    let openPrs: DiscoveredPr[] = [makeDiscoveredPr({ number: 1 })];
    const transport: PrReadTransport = {
      listOpenPrs: () => Promise.resolve(openPrs),
    };
    const config = configWithBasePr();
    const resolveWorkflow = resolverFor([makeWorkflowGraph({ id: "base-pr" })]);

    await runSelfDiscoveryPass(db, config, { transport, resolveWorkflow });
    // A second PR opens between passes; the next pass must see it without any
    // stored queue being mutated by the caller.
    openPrs = [
      makeDiscoveredPr({ number: 1 }),
      makeDiscoveredPr({ number: 2 }),
    ];
    const second = await runSelfDiscoveryPass(db, config, {
      transport,
      resolveWorkflow,
    });

    // PR #1 is already enrolled (no new run); PR #2 is newly enrolled.
    expect(
      second.enrolled.map((e) => ({ n: e.pr.number, created: e.created })),
    ).toEqual([
      { n: 1, created: false },
      { n: 2, created: true },
    ]);
    const runs = await db.list(Collections.workflowRuns);
    expect(runs).toHaveLength(2);
  });
});

describe("does not double-enroll already-enrolled / in-flight PRs", () => {
  it("creates no second run when the same PR is discovered again", async () => {
    const db = freshDb();
    const transport = transportReturning([makeDiscoveredPr({ number: 7 })]);
    const config = configWithBasePr();
    const resolveWorkflow = resolverFor([makeWorkflowGraph({ id: "base-pr" })]);

    const first = await runSelfDiscoveryPass(db, config, {
      transport,
      resolveWorkflow,
    });
    const second = await runSelfDiscoveryPass(db, config, {
      transport,
      resolveWorkflow,
    });

    expect(first.enrolled[0]?.created).toBe(true);
    expect(second.enrolled[0]?.created).toBe(false);
    const runs = await db.list(Collections.workflowRuns);
    expect(runs).toHaveLength(1);
  });
});

describe("logs exclusion reasons for each pass", () => {
  it("reports and logs PRs skipped because no workflow matched", async () => {
    const db = freshDb();
    const transport = transportReturning([
      makeDiscoveredPr({ number: 3, author: "octocat" }),
    ]);
    // No workflow entry matches `octocat` (only `dependabot[bot]` is mapped).
    const config = makeConfig([
      makeRepositoryConfig({
        workflows: [{ match: "dependabot[bot]", workflowId: "dependabot-pr" }],
      }),
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const report = await runSelfDiscoveryPass(db, config, {
      transport,
      resolveWorkflow: resolverFor([
        makeWorkflowGraph({ id: "dependabot-pr" }),
      ]),
      phase: DiscoveryPhase.Upfront,
    });

    expect(report.enrolled).toHaveLength(0);
    expect(report.skipped).toEqual([
      {
        pr: expect.objectContaining({ number: 3 }),
        reason: SkipReason.NoMatch,
      },
    ]);
    // The exclusion is logged with its reason so each pass is observable.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(SkipReason.NoMatch),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("upfront"));
    warn.mockRestore();
  });

  it("surfaces tolerated per-repo discovery errors in the report", async () => {
    const db = freshDb();
    const transport: PrReadTransport = {
      listOpenPrs: () => Promise.reject(new Error("rate limited")),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const report = await runSelfDiscoveryPass(db, configWithBasePr(), {
      transport,
      resolveWorkflow: resolverFor([makeWorkflowGraph({ id: "base-pr" })]),
    });

    expect(report.discoveryErrors).toEqual([
      { repo: "owner/repo", message: "rate limited" },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rate limited"));
    warn.mockRestore();
  });
});

describe("annotates the pass with the triggering phase", () => {
  it("defaults to the upfront phase when none is supplied", async () => {
    const db = freshDb();
    const transport = transportReturning([makeDiscoveredPr({ number: 9 })]);

    const report = await runSelfDiscoveryPass(db, configWithBasePr(), {
      transport,
      resolveWorkflow: resolverFor([makeWorkflowGraph({ id: "base-pr" })]),
    });

    expect(report.phase).toBe(DiscoveryPhase.Upfront);
  });

  it("carries the supplied phase through to the report", async () => {
    const db = freshDb();
    const transport = transportReturning([makeDiscoveredPr({ number: 10 })]);

    const report = await runSelfDiscoveryPass(db, configWithBasePr(), {
      transport,
      resolveWorkflow: resolverFor([makeWorkflowGraph({ id: "base-pr" })]),
      phase: DiscoveryPhase.EndOfDrain,
    });

    expect(report.phase).toBe(DiscoveryPhase.EndOfDrain);
  });
});
