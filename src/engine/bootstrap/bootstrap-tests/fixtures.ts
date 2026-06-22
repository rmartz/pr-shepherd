import type { Config } from "@/config";
import { DbAdapterKind } from "@/db";
import type { DiscoveredPr, PrReadTransport } from "@/engine/discovery";
import type { WorkflowResolver } from "@/engine/enrollment";
import {
  makeConfig,
  makeRepositoryConfig,
  makeWorkflowGraph,
} from "@/engine/enrollment/enrollment-tests/fixtures";

// Shared fixtures for the engine-bootstrap tests (#207). Kept in one place so
// the bootstrap spec builds identical wiring inputs across its cases.

// A config watching one repo whose `*` author maps to the `base-pr` workflow,
// backed by the in-memory adapter so the bootstrap's `createDb` default builds
// a real (non-network) `Db`.
export function makeBootstrapConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...makeConfig([
      makeRepositoryConfig({
        workflows: [{ match: "*", workflowId: "base-pr" }],
      }),
    ]),
    db: { adapter: DbAdapterKind.InMemory, logOverflowPath: "./data/logs" },
    ...overrides,
  };
}

// A transport whose sweep returns a fixed set of open PRs, filtered to the
// requested repo, with no per-repo errors.
export function transportReturning(prs: DiscoveredPr[]): PrReadTransport {
  return {
    listOpenPrs: (repoId) =>
      Promise.resolve(prs.filter((pr) => pr.repo === repoId)),
  };
}

// A resolver that knows the `base-pr` graph, so a discovered PR enrolls rather
// than being skipped as `unresolved_workflow`.
export function resolverWithBasePr(): WorkflowResolver {
  const graph = makeWorkflowGraph({ id: "base-pr" });
  return (id) => (id === graph.id ? graph : undefined);
}
