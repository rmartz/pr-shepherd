import { describe, expect, it } from "vitest";
import type { WorkflowGraph } from "@/config";
import { Collections, createDb, DbAdapterKind } from "@/db";
import type { Db } from "@/db/types";
import type { DiscoverySweep } from "@/engine/discovery";
import { enrollDiscovered, SkipReason } from "./enrollDiscovered";
import {
  makeConfig,
  makeDiscoveredPr,
  makeRepositoryConfig,
  makeWorkflowGraph,
} from "./enrollment-tests/fixtures";

// ---------------------------------------------------------------------------
// Tests for `enrollDiscovered` — the discovery → enrollment orchestration
// that backs the `onDiscovered` hook (#125) and the self-discovery path
// (#108). Smoke-tests that it correctly chains match → resolve → enroll over
// a discovery sweep, rather than re-testing the lower-level edge cases owned
// by match.spec.ts and enroll.spec.ts.
// ---------------------------------------------------------------------------

function freshDb(): Db {
  return createDb({ adapter: DbAdapterKind.InMemory });
}

function sweepOf(
  ...prs: ReturnType<typeof makeDiscoveredPr>[]
): DiscoverySweep {
  return { discovered: prs, errors: [] };
}

// Resolver backed by an id→graph map; an unknown id resolves to undefined.
function resolverFor(
  graphs: WorkflowGraph[],
): (id: string) => WorkflowGraph | undefined {
  const byId = new Map(graphs.map((g) => [g.id, g]));
  return (id) => byId.get(id);
}

describe("integrates with the discovery sweep output", () => {
  it("matches each discovered PR and enrolls a run for it", async () => {
    const db = freshDb();
    const config = makeConfig([
      makeRepositoryConfig({
        workflows: [
          { match: "dependabot[bot]", workflowId: "dependabot-pr" },
          { match: "*", workflowId: "base-pr" },
        ],
      }),
    ]);
    const sweep = sweepOf(
      makeDiscoveredPr({ number: 1, author: "dependabot[bot]" }),
      makeDiscoveredPr({ number: 2, author: "octocat" }),
    );
    const resolve = resolverFor([
      makeWorkflowGraph({ id: "dependabot-pr" }),
      makeWorkflowGraph({ id: "base-pr" }),
    ]);

    const report = await enrollDiscovered(db, config, sweep, resolve);

    expect(report.enrolled.map((e) => e.workflowId)).toEqual([
      "dependabot-pr",
      "base-pr",
    ]);
    const runs = await db.list(Collections.workflowRuns);
    expect(runs).toHaveLength(2);
  });

  it("does not double-enroll across two sweeps of the same PR", async () => {
    const db = freshDb();
    const config = makeConfig([makeRepositoryConfig()]);
    const resolve = resolverFor([makeWorkflowGraph({ id: "base-pr" })]);
    const sweep = sweepOf(makeDiscoveredPr({ number: 7 }));

    await enrollDiscovered(db, config, sweep, resolve);
    const second = await enrollDiscovered(db, config, sweep, resolve);

    expect(second.enrolled[0]?.created).toBe(false);
    const runs = await db.list(Collections.workflowRuns);
    expect(runs).toHaveLength(1);
  });
});

describe("a PR that matches nothing is skipped", () => {
  it("records an unknown-repo skip for a PR whose repo is not in the config", async () => {
    const db = freshDb();
    const config = makeConfig([
      makeRepositoryConfig({ id: "known-owner/repo" }),
    ]);
    const resolve = resolverFor([makeWorkflowGraph()]);
    const sweep = sweepOf(makeDiscoveredPr({ repo: "other-owner/repo" }));

    const report = await enrollDiscovered(db, config, sweep, resolve);

    expect(report.enrolled).toHaveLength(0);
    expect(report.skipped[0]?.reason).toBe(SkipReason.UnknownRepo);
  });

  it("records a no-match skip and enrolls no run", async () => {
    const db = freshDb();
    const config = makeConfig([
      makeRepositoryConfig({
        workflows: [{ match: "dependabot[bot]", workflowId: "dependabot-pr" }],
      }),
    ]);
    const resolve = resolverFor([makeWorkflowGraph({ id: "dependabot-pr" })]);
    const sweep = sweepOf(makeDiscoveredPr({ author: "octocat" }));

    const report = await enrollDiscovered(db, config, sweep, resolve);

    expect(report.enrolled).toHaveLength(0);
    expect(report.skipped[0]?.reason).toBe(SkipReason.NoMatch);
  });

  it("skips a PR whose matched workflow cannot be resolved", async () => {
    const db = freshDb();
    const config = makeConfig([makeRepositoryConfig()]);
    const resolve = resolverFor([]);
    const sweep = sweepOf(makeDiscoveredPr());

    const report = await enrollDiscovered(db, config, sweep, resolve);

    expect(report.skipped[0]?.reason).toBe(SkipReason.UnresolvedWorkflow);
    expect(report.skipped[0]?.workflowId).toBe("base-pr");
  });
});
