import type { Config, RepositoryConfig, WorkflowGraph } from "@/config";
import { DbAdapterKind } from "@/db";
import { StepType } from "@/db/schemas";
import type { DiscoveredPr } from "@/engine/discovery";

// Shared fixture generators for the enrollment module tests. Kept in one place
// so the match / enroll / enrollDiscovered specs build identical inputs.

export function makeRepositoryConfig(
  overrides: Partial<RepositoryConfig> = {},
): RepositoryConfig {
  return {
    id: "owner/repo",
    enabled: true,
    workflows: [{ match: "*", workflowId: "base-pr" }],
    ...overrides,
  };
}

export function makeConfig(repositories: RepositoryConfig[]): Config {
  return {
    concurrency: { systemMax: 8, githubApiMax: 4, defaultRepoMax: 2 },
    repositories,
    poll: {
      newPrIntervalSeconds: 60,
      schedulerIntervalSeconds: 5,
      heartbeatIntervalSeconds: 15,
    },
    db: { adapter: DbAdapterKind.InMemory, logOverflowPath: "./data/logs" },
    commands: { collectionPath: "commands", pollIntervalSeconds: 5 },
  };
}

export function makeDiscoveredPr(
  overrides: Partial<DiscoveredPr> = {},
): DiscoveredPr {
  return {
    repo: "owner/repo",
    number: 1,
    author: "octocat",
    title: "Add a thing",
    ...overrides,
  };
}

export function makeWorkflowGraph(
  overrides: Partial<WorkflowGraph> = {},
): WorkflowGraph {
  return {
    id: "base-pr",
    version: 7,
    source: "id: base-pr\nversion: 7\n",
    steps: [
      {
        id: "triage",
        stepType: StepType.Decision,
        input: { mode: "initial" },
        routing: [{ condition: "output.ok", next: undefined }],
      },
    ],
    ...overrides,
  };
}
