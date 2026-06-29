import { describe, it, expect, vi } from "vitest";
import { fetchPrSnapshot } from "../snapshot";
import {
  TARGET,
  graphqlResponse,
  REST_REVIEWS,
  REST_COMMENTS,
} from "./fixtures";
import type { GithubReadTransport } from "../types";

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
