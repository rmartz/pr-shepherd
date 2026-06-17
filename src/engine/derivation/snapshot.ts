import type {
  CheckSuiteSnapshot,
  CommitStatusSnapshot,
  GithubReadTransport,
  IssueCommentSnapshot,
  PrSnapshot,
  PrSnapshotTarget,
  ReviewSnapshot,
  ReviewThreadSnapshot,
} from "./types";
import type {
  GqlConnection,
  GraphqlResponse,
  RestComment,
  RestReview,
} from "./snapshot-graphql";
import { SNAPSHOT_QUERY } from "./snapshot-graphql";

// ---------------------------------------------------------------------------
// PR state snapshot fetcher (Epic 10, #95).
//
// One rate-limited GitHub read assembled from:
//   - a single GraphQL query for metadata, labels, commit OIDs, review
//     threads, and a HEAD-only CI alias; and
//   - paginated REST for reviews and issue comments (GraphQL `last:N`
//     silently truncates — fetching these via REST avoids the truncation
//     that corrupted "Copilot reviewed after approval" / "delegated" flags).
//
// CI (check suites + commit statuses) is fetched on a dedicated
// `commits(last: 1)` HEAD alias, never nested under the full commit
// connection — a nested `commits × checkSuites` query is a 10–50× cost
// blowup. Results are deduplicated through an optional shared TTL cache so a
// burst of concurrent consumers shares one real query, and a rate-limit
// rejection is retried once after a backoff.
// ---------------------------------------------------------------------------

export class GithubRateLimitError extends Error {
  constructor(message = "GitHub rate limit hit") {
    super(message);
    this.name = "GithubRateLimitError";
  }
}

const DEFAULT_TTL_MS = 120_000;
const DEFAULT_RATE_LIMIT_RETRIES = 1;
const DEFAULT_BACKOFF_MS = 1_000;

interface CacheEntry {
  promise: Promise<PrSnapshot>;
  expiresAt: number;
}

// A PR-keyed snapshot cache. Callers hold one and pass it to `fetchPrSnapshot`
// so concurrent and repeat reads of the same PR share a single fetch within
// the TTL. Tests construct a fresh one to stay isolated.
export interface SnapshotCache {
  entries: Map<string, CacheEntry>;
}

export function createSnapshotCache(): SnapshotCache {
  return { entries: new Map<string, CacheEntry>() };
}

export interface FetchPrSnapshotOptions {
  cache?: SnapshotCache;
  now?: () => number;
  ttlMs?: number;
  sleep?: (ms: number) => Promise<void>;
  rateLimitRetries?: number;
  backoffMs?: number;
  // When the caller already knows the current HEAD (e.g. from a webhook
  // payload), pass it so the cache key includes the SHA — a new commit then
  // misses the cache instead of being served stale within the TTL.
  expectedHeadOid?: string;
}

export async function fetchPrSnapshot(
  transport: GithubReadTransport,
  target: PrSnapshotTarget,
  options: FetchPrSnapshotOptions = {},
): Promise<PrSnapshot> {
  const cache = options.cache;
  if (cache === undefined) {
    return runFetch(transport, target, options);
  }

  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const key = cacheKey(target, options.expectedHeadOid);
  const existing = cache.entries.get(key);
  if (existing !== undefined && now() < existing.expiresAt) {
    return existing.promise;
  }

  const promise = runFetch(transport, target, options);
  cache.entries.set(key, { promise, expiresAt: now() + ttlMs });
  // A rejected fetch must not poison the cache — drop it so the next call
  // re-fetches rather than replaying the failure for the whole TTL.
  promise.catch(() => {
    const current = cache.entries.get(key);
    if (current?.promise === promise) cache.entries.delete(key);
  });
  return promise;
}

function cacheKey(
  target: PrSnapshotTarget,
  headOid: string | undefined,
): string {
  const base = `${target.owner}/${target.repo}#${String(target.prNumber)}`;
  return headOid === undefined ? base : `${base}@${headOid}`;
}

async function runFetch(
  transport: GithubReadTransport,
  target: PrSnapshotTarget,
  options: FetchPrSnapshotOptions,
): Promise<PrSnapshot> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.rateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;

  const data = await withRateLimitRetry(
    () =>
      transport.graphql<GraphqlResponse>(SNAPSHOT_QUERY, {
        owner: target.owner,
        name: target.repo,
        number: target.prNumber,
      }),
    retries,
    backoffMs,
    sleep,
  );
  const reviewsRaw = await withRateLimitRetry(
    () =>
      transport.restPaginate<RestReview>(
        `/repos/${target.owner}/${target.repo}/pulls/${String(target.prNumber)}/reviews`,
        { per_page: 100 },
      ),
    retries,
    backoffMs,
    sleep,
  );
  const commentsRaw = await withRateLimitRetry(
    () =>
      transport.restPaginate<RestComment>(
        `/repos/${target.owner}/${target.repo}/issues/${String(target.prNumber)}/comments`,
        { per_page: 100 },
      ),
    retries,
    backoffMs,
    sleep,
  );

  return mapSnapshot(target, data, reviewsRaw, commentsRaw, now());
}

async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  backoffMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GithubRateLimitError && attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nodesOf<T>(connection: GqlConnection<T> | undefined): T[] {
  return (connection?.nodes ?? []).filter((n): n is T => n != null);
}

function mapSnapshot(
  target: PrSnapshotTarget,
  data: GraphqlResponse,
  reviewsRaw: RestReview[],
  commentsRaw: RestComment[],
  fetchedAt: number,
): PrSnapshot {
  const pr = data.repository?.pullRequest ?? undefined;
  const headCommit = nodesOf(pr?.headCommit)[0]?.commit;

  const checkSuites: CheckSuiteSnapshot[] = nodesOf(
    headCommit?.checkSuites,
  ).map((s) => ({
    appName: s.app?.name ?? undefined,
    workflowName: s.workflowRun?.workflow?.name ?? undefined,
    status: s.status ?? "",
    conclusion: s.conclusion ?? undefined,
  }));
  const commitStatuses: CommitStatusSnapshot[] = (
    headCommit?.status?.contexts ?? []
  ).map((c) => ({
    context: c.context ?? "",
    state: c.state ?? "",
    description: c.description ?? undefined,
    targetUrl: c.targetUrl ?? undefined,
  }));
  const reviewThreads: ReviewThreadSnapshot[] = nodesOf(pr?.reviewThreads).map(
    (t) => ({
      id: t.id ?? "",
      isResolved: t.isResolved ?? false,
      isOutdated: t.isOutdated ?? false,
      firstCommentAuthor: nodesOf(t.comments)[0]?.author?.login ?? undefined,
    }),
  );
  const reviews: ReviewSnapshot[] = reviewsRaw.map((r) => ({
    id: r.id ?? 0,
    author: r.user?.login ?? undefined,
    state: r.state ?? "",
    submittedAt: r.submitted_at ?? undefined,
    commitOid: r.commit_id ?? undefined,
    body: r.body ?? "",
  }));
  const issueComments: IssueCommentSnapshot[] = commentsRaw.map((c) => ({
    id: c.id ?? 0,
    author: c.user?.login ?? undefined,
    body: c.body ?? "",
    createdAt: c.created_at ?? undefined,
  }));

  return {
    owner: target.owner,
    repo: target.repo,
    number: pr?.number ?? target.prNumber,
    title: pr?.title ?? "",
    isDraft: pr?.isDraft ?? false,
    mergeable: pr?.mergeable ?? "UNKNOWN",
    baseRefName: pr?.baseRefName ?? "",
    headRefName: pr?.headRefName ?? "",
    author: pr?.author?.login ?? undefined,
    headOid: headCommit?.oid ?? undefined,
    labels: nodesOf(pr?.labels).map((l) => l.name ?? ""),
    commitOids: nodesOf(pr?.commits).map((c) => c.commit?.oid ?? ""),
    checkSuites,
    commitStatuses,
    reviews,
    reviewThreads,
    issueComments,
    fetchedAt,
  };
}
