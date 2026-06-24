// ---------------------------------------------------------------------------
// GraphQL query and raw response shapes for the PR snapshot fetcher (#95).
//
// These are the wire-level types the snapshot read assembles into a typed
// `PrSnapshot`. None are exported from the module barrel — they exist only so
// `snapshot.ts` can map them defensively into the public snapshot shape.
// ---------------------------------------------------------------------------

// The review-threads connection selection, shared by the main snapshot query
// and the continuation query that pages past the first 100 threads. `first` +
// `after` (forward cursor pagination) — never `last: N`, which silently drops
// every thread beyond the cap (#141).
const REVIEW_THREADS_SELECTION = `reviewThreads(first: 100, after: $threadCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 1) { nodes { author { login } } }
        }
      }`;

export const SNAPSHOT_QUERY = `query PrSnapshot($owner: String!, $name: String!, $number: Int!, $threadCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      body
      isDraft
      mergeable
      baseRefName
      headRefName
      author { login }
      labels(first: 100) { nodes { name } }
      commits(last: 100) { nodes { commit { oid } } }
      headCommit: commits(last: 1) {
        nodes {
          commit {
            oid
            checkSuites(first: 50) {
              nodes {
                app { name }
                status
                conclusion
                workflowRun { workflow { name } }
              }
            }
            status { contexts { context state description targetUrl } }
          }
        }
      }
      ${REVIEW_THREADS_SELECTION}
    }
  }
}`;

// Continuation query: fetches only the review-threads connection for a given
// cursor, used to drain pages beyond the first when a PR has >100 threads.
export const REVIEW_THREADS_QUERY = `query PrReviewThreads($owner: String!, $name: String!, $number: Int!, $threadCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${REVIEW_THREADS_SELECTION}
    }
  }
}`;

// --- Raw response shapes (lightly typed; mapping is defensive) --------------

export interface GqlConnection<T> {
  nodes?: (T | null)[] | null;
}
export interface GqlPageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}
// A connection that carries forward-pagination cursors (review threads).
export interface GqlPagedConnection<T> extends GqlConnection<T> {
  pageInfo?: GqlPageInfo;
}
export interface GqlActor {
  login?: string;
}
export interface GqlCommitNode {
  commit?: { oid?: string };
}
export interface GqlCheckSuite {
  app?: { name?: string } | null;
  status?: string;
  conclusion?: string | null;
  workflowRun?: { workflow?: { name?: string } | null } | null;
}
export interface GqlStatusContext {
  context?: string;
  state?: string;
  description?: string | null;
  targetUrl?: string | null;
}
export interface GqlHeadCommitNode {
  commit?: {
    oid?: string;
    checkSuites?: GqlConnection<GqlCheckSuite>;
    status?: { contexts?: GqlStatusContext[] | null } | null;
  };
}
export interface GqlReviewThread {
  id?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  comments?: GqlConnection<{ author?: GqlActor | null }>;
}
export interface GraphqlResponse {
  repository?: {
    pullRequest?: {
      number?: number;
      title?: string;
      body?: string;
      isDraft?: boolean;
      mergeable?: string;
      baseRefName?: string;
      headRefName?: string;
      author?: GqlActor | null;
      labels?: GqlConnection<{ name?: string }>;
      commits?: GqlConnection<GqlCommitNode>;
      headCommit?: GqlConnection<GqlHeadCommitNode>;
      reviewThreads?: GqlPagedConnection<GqlReviewThread>;
    } | null;
  } | null;
}
// Response shape for the review-threads continuation query.
export interface ReviewThreadsResponse {
  repository?: {
    pullRequest?: {
      reviewThreads?: GqlPagedConnection<GqlReviewThread>;
    } | null;
  } | null;
}
export interface RestReview {
  id?: number;
  user?: { login?: string } | null;
  state?: string;
  submitted_at?: string;
  commit_id?: string;
  body?: string;
}
export interface RestComment {
  id?: number;
  user?: { login?: string } | null;
  body?: string;
  created_at?: string;
}
