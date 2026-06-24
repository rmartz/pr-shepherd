import type { GithubReadTransport, PrSnapshotTarget } from "./types";
import type {
  GqlPagedConnection,
  GqlReviewThread,
  ReviewThreadsResponse,
} from "./snapshot-graphql";
import { REVIEW_THREADS_QUERY } from "./snapshot-graphql";

// ---------------------------------------------------------------------------
// Review-thread pagination (#141).
//
// The main snapshot query fetches the first page of review threads inline; a
// PR with >100 inline threads carries the rest behind a forward cursor. This
// module drains those remaining pages so the snapshot captures every thread
// rather than silently truncating at the GraphQL connection cap. Each
// continuation read is run through the caller's rate-limit retry wrapper, like
// the rest of the snapshot fetch.
// ---------------------------------------------------------------------------

type RateLimitRetry = <T>(fn: () => Promise<T>) => Promise<T>;

// Drains every review-thread page after the first. `firstPage` is the threads
// connection already returned by the main snapshot query; this follows its
// `pageInfo` cursor until `hasNextPage` is false and returns the concatenated
// nodes from the first page plus all continuation pages.
export async function collectReviewThreads(
  transport: GithubReadTransport,
  target: PrSnapshotTarget,
  firstPage: GqlPagedConnection<GqlReviewThread> | undefined,
  withRateLimitRetry: RateLimitRetry,
): Promise<(GqlReviewThread | null)[]> {
  const threads: (GqlReviewThread | null)[] = [...(firstPage?.nodes ?? [])];
  let pageInfo = firstPage?.pageInfo;

  while (pageInfo?.hasNextPage === true && pageInfo.endCursor != null) {
    const cursor = pageInfo.endCursor;
    const data = await withRateLimitRetry(() =>
      transport.graphql<ReviewThreadsResponse>(REVIEW_THREADS_QUERY, {
        owner: target.owner,
        name: target.repo,
        number: target.prNumber,
        threadCursor: cursor,
      }),
    );
    const connection = data.repository?.pullRequest?.reviewThreads;
    threads.push(...(connection?.nodes ?? []));
    pageInfo = connection?.pageInfo;
  }

  return threads;
}
