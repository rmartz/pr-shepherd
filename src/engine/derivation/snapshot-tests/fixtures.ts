import { vi } from "vitest";
import type { GithubReadTransport } from "../types";

export const TARGET = { owner: "rmartz", repo: "pr-shepherd", prNumber: 7 };

export function graphqlResponse(): unknown {
  return {
    repository: {
      pullRequest: {
        number: 7,
        title: "Add a thing",
        body: "Dependabot is rebasing this PR",
        isDraft: false,
        mergeable: "MERGEABLE",
        baseRefName: "main",
        headRefName: "feat/thing",
        author: { login: "rmartz" },
        labels: { nodes: [{ name: "Engine" }, { name: "approved" }] },
        commits: {
          nodes: [
            { commit: { oid: "oid-old" } },
            { commit: { oid: "oid-head" } },
          ],
        },
        headCommit: {
          nodes: [
            {
              commit: {
                oid: "oid-head",
                checkSuites: {
                  nodes: [
                    {
                      app: { name: "GitHub Actions" },
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      workflowRun: { workflow: { name: "CI" } },
                    },
                  ],
                },
                status: {
                  contexts: [
                    {
                      context: "Vercel",
                      state: "PENDING",
                      description: "Deploying",
                      targetUrl: "https://vercel.example/x",
                    },
                  ],
                },
              },
            },
          ],
        },
        reviewThreads: {
          nodes: [
            {
              id: "thread-1",
              isResolved: false,
              isOutdated: false,
              comments: {
                nodes: [{ author: { login: "copilot-pull-request-reviewer" } }],
              },
            },
          ],
        },
      },
    },
  };
}

export const REST_REVIEWS = [
  {
    id: 1001,
    user: { login: "rmartz" },
    state: "APPROVED",
    submitted_at: "2026-06-01T00:00:00Z",
    commit_id: "oid-head",
    body: "lgtm",
  },
];

export const REST_COMMENTS = [
  {
    id: 2001,
    user: { login: "rmartz" },
    body: "a comment",
    created_at: "2026-06-01T00:01:00Z",
  },
];

export function makeTransport(): GithubReadTransport & {
  graphql: ReturnType<typeof vi.fn>;
  restPaginate: ReturnType<typeof vi.fn>;
} {
  const graphql = vi.fn(
    (): Promise<unknown> => Promise.resolve(graphqlResponse()),
  );
  const restPaginate = vi.fn(
    (path: string): Promise<unknown[]> =>
      Promise.resolve(path.includes("/reviews") ? REST_REVIEWS : REST_COMMENTS),
  );
  return { graphql, restPaginate } as never;
}
