import { describe, it, expect, vi } from "vitest";
import {
  fetchPrSnapshot,
  createSnapshotCache,
  GithubRateLimitError,
} from "./snapshot";
import type { GithubReadTransport } from "./types";

// ---------------------------------------------------------------------------
// Tests for the PR state snapshot fetcher. The fetcher issues ONE GraphQL
// read (metadata + commits + labels + a HEAD-only CI alias + review threads)
// and paginated REST reads for reviews and issue comments, returning a typed
// raw `PrSnapshot`. The transport is injected so tests script responses
// without real HTTP — mirroring the `GithubTransport` seam from #46.
// ---------------------------------------------------------------------------

const TARGET = { owner: "rmartz", repo: "pr-shepherd", prNumber: 7 };

function graphqlResponse(): unknown {
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

const REST_REVIEWS = [
  {
    id: 1001,
    user: { login: "rmartz" },
    state: "APPROVED",
    submitted_at: "2026-06-01T00:00:00Z",
    commit_id: "oid-head",
    body: "lgtm",
  },
];

const REST_COMMENTS = [
  {
    id: 2001,
    user: { login: "rmartz" },
    body: "a comment",
    created_at: "2026-06-01T00:01:00Z",
  },
];

function makeTransport(): GithubReadTransport & {
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

describe("fetchPrSnapshot returns a typed snapshot from one GraphQL read + paginated REST", () => {
  it("maps every section of the raw GitHub data into the snapshot", async () => {
    const transport = makeTransport();
    const snap = await fetchPrSnapshot(transport, TARGET);

    expect(snap.number).toBe(7);
    expect(snap.body).toBe("Dependabot is rebasing this PR");
    expect(snap.headOid).toBe("oid-head");
    expect(snap.mergeable).toBe("MERGEABLE");
    expect(snap.author).toBe("rmartz");
    expect(snap.labels).toEqual(["Engine", "approved"]);
    // Commit OIDs preserved in graph order (oldest → newest).
    expect(snap.commitOids).toEqual(["oid-old", "oid-head"]);
    expect(snap.checkSuites).toEqual([
      {
        appName: "GitHub Actions",
        workflowName: "CI",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
    ]);
    expect(snap.commitStatuses).toEqual([
      {
        context: "Vercel",
        state: "PENDING",
        description: "Deploying",
        targetUrl: "https://vercel.example/x",
      },
    ]);
    expect(snap.reviews).toEqual([
      {
        id: 1001,
        author: "rmartz",
        state: "APPROVED",
        submittedAt: "2026-06-01T00:00:00Z",
        commitOid: "oid-head",
        body: "lgtm",
      },
    ]);
    expect(snap.reviewThreads).toEqual([
      {
        id: "thread-1",
        isResolved: false,
        isOutdated: false,
        firstCommentAuthor: "copilot-pull-request-reviewer",
      },
    ]);
    expect(snap.issueComments).toEqual([
      {
        id: 2001,
        author: "rmartz",
        body: "a comment",
        createdAt: "2026-06-01T00:01:00Z",
      },
    ]);
  });
});

describe("CI data is fetched on a HEAD-only commit alias", () => {
  it("queries checkSuites under a `commits(last: 1)` head alias, not the full commit connection", async () => {
    const transport = makeTransport();
    await fetchPrSnapshot(transport, TARGET);

    const query = transport.graphql.mock.calls[0]?.[0] as string;
    expect(query).toContain("headCommit: commits(last: 1)");
    expect(query).toContain("commits(last: 100)");
    // checkSuites must hang off the HEAD alias, after it — never nested in the
    // full commits(last: 100) connection (a 10–50× cost blowup).
    expect(query.indexOf("checkSuites")).toBeGreaterThan(
      query.indexOf("headCommit: commits(last: 1)"),
    );
  });
});

describe("reviews and comments come from paginated REST", () => {
  it("calls restPaginate for the reviews and issue-comments endpoints", async () => {
    const transport = makeTransport();
    await fetchPrSnapshot(transport, TARGET);

    const paths = transport.restPaginate.mock.calls.map((c) => c[0] as string);
    expect(paths).toContain("/repos/rmartz/pr-shepherd/pulls/7/reviews");
    expect(paths).toContain("/repos/rmartz/pr-shepherd/issues/7/comments");
  });
});

describe("concurrent reads of the same PR dedupe to a single fetch", () => {
  it("shares one in-flight fetch when a cache is provided", async () => {
    const transport = makeTransport();
    const cache = createSnapshotCache();
    const [a, b] = await Promise.all([
      fetchPrSnapshot(transport, TARGET, { cache }),
      fetchPrSnapshot(transport, TARGET, { cache }),
    ]);
    expect(transport.graphql).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });
});

describe("a cached snapshot is reused within the TTL and refetched after it expires", () => {
  it("refetches only once the TTL has elapsed", async () => {
    const transport = makeTransport();
    const cache = createSnapshotCache();
    let clock = 1000;
    const now = () => clock;
    await fetchPrSnapshot(transport, TARGET, { cache, now, ttlMs: 120_000 });
    clock = 1000 + 119_000; // within TTL
    await fetchPrSnapshot(transport, TARGET, { cache, now, ttlMs: 120_000 });
    expect(transport.graphql).toHaveBeenCalledTimes(1);
    clock = 1000 + 121_000; // past TTL
    await fetchPrSnapshot(transport, TARGET, { cache, now, ttlMs: 120_000 });
    expect(transport.graphql).toHaveBeenCalledTimes(2);
  });
});

describe("review threads are fully paginated, not truncated at 100", () => {
  it("follows the thread connection's cursor across pages and concatenates every thread", async () => {
    // Page 1: a full page of 100 threads with more to come.
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      id: `thread-${String(i)}`,
      isResolved: false,
      isOutdated: false,
      comments: { nodes: [{ author: { login: "rmartz" } }] },
    }));
    // Page 2: the overflow threads the old `last: 100` query silently dropped.
    const secondPage = [
      {
        id: "thread-overflow",
        isResolved: true,
        isOutdated: true,
        comments: { nodes: [{ author: { login: "copilot" } }] },
      },
    ];

    let graphqlCalls = 0;
    const graphql = vi.fn((_query: string, variables): Promise<unknown> => {
      const cursor = (variables as { threadCursor?: string }).threadCursor;
      graphqlCalls += 1;
      const base = graphqlResponse() as {
        repository: { pullRequest: { reviewThreads?: unknown } };
      };
      const threads =
        cursor === undefined
          ? {
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              nodes: firstPage,
            }
          : {
              pageInfo: { hasNextPage: false, endCursor: undefined },
              nodes: secondPage,
            };
      base.repository.pullRequest.reviewThreads = threads;
      return Promise.resolve(base);
    });
    const restPaginate = vi.fn(
      (path: string): Promise<unknown[]> =>
        Promise.resolve(
          path.includes("/reviews") ? REST_REVIEWS : REST_COMMENTS,
        ),
    );
    const transport = {
      graphql,
      restPaginate,
    } as unknown as GithubReadTransport;

    const snap = await fetchPrSnapshot(transport, TARGET);

    expect(graphqlCalls).toBe(2);
    expect(snap.reviewThreads).toHaveLength(101);
    expect(snap.reviewThreads[100]).toEqual({
      id: "thread-overflow",
      isResolved: true,
      isOutdated: true,
      firstCommentAuthor: "copilot",
    });
  });
});

describe("a rate-limit error is retried once after a backoff", () => {
  it("sleeps and retries the GraphQL read on a GithubRateLimitError", async () => {
    let calls = 0;
    const graphql = vi.fn((): Promise<unknown> => {
      calls += 1;
      if (calls === 1) return Promise.reject(new GithubRateLimitError());
      return Promise.resolve(graphqlResponse());
    });
    const restPaginate = vi.fn(
      (path: string): Promise<unknown[]> =>
        Promise.resolve(
          path.includes("/reviews") ? REST_REVIEWS : REST_COMMENTS,
        ),
    );
    const transport = {
      graphql,
      restPaginate,
    } as unknown as GithubReadTransport;
    const sleep = vi.fn((): Promise<void> => Promise.resolve());

    const snap = await fetchPrSnapshot(transport, TARGET, { sleep });

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(snap.headOid).toBe("oid-head");
  });
});
