import { describe, it, expect, vi } from "vitest";
import { fetchPrSnapshot, GithubRateLimitError } from "../snapshot";
import {
  TARGET,
  graphqlResponse,
  REST_REVIEWS,
  REST_COMMENTS,
} from "./fixtures";
import type { GithubReadTransport } from "../types";

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
