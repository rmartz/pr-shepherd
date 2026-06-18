// ---------------------------------------------------------------------------
// GraphQL query and raw response shapes for the PR snapshot fetcher (#95).
//
// These are the wire-level types the snapshot read assembles into a typed
// `PrSnapshot`. None are exported from the module barrel — they exist only so
// `snapshot.ts` can map them defensively into the public snapshot shape.
// ---------------------------------------------------------------------------

export const SNAPSHOT_QUERY = `query PrSnapshot($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
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
      reviewThreads(last: 100) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 1) { nodes { author { login } } }
        }
      }
    }
  }
}`;

// --- Raw response shapes (lightly typed; mapping is defensive) --------------

export interface GqlConnection<T> {
  nodes?: (T | null)[] | null;
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
      isDraft?: boolean;
      mergeable?: string;
      baseRefName?: string;
      headRefName?: string;
      author?: GqlActor | null;
      labels?: GqlConnection<{ name?: string }>;
      commits?: GqlConnection<GqlCommitNode>;
      headCommit?: GqlConnection<GqlHeadCommitNode>;
      reviewThreads?: GqlConnection<GqlReviewThread>;
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
