import type {
  CheckSuiteSnapshot,
  CommitStatusSnapshot,
  IssueCommentSnapshot,
  PrSnapshot,
  PrSnapshotTarget,
  ReviewSnapshot,
  ReviewThreadSnapshot,
} from "./types";
import type {
  GqlConnection,
  GqlReviewThread,
  GraphqlResponse,
  RestComment,
  RestReview,
} from "./snapshot-graphql";

function nodesOf<T>(connection: GqlConnection<T> | undefined): T[] {
  return (connection?.nodes ?? []).filter((n): n is T => n != null);
}

export function mapSnapshot(
  target: PrSnapshotTarget,
  data: GraphqlResponse,
  reviewThreadNodes: (GqlReviewThread | null)[],
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
  const reviewThreads: ReviewThreadSnapshot[] = reviewThreadNodes
    .filter((t): t is GqlReviewThread => t != null)
    .map((t) => ({
      id: t.id ?? "",
      isResolved: t.isResolved ?? false,
      isOutdated: t.isOutdated ?? false,
      firstCommentAuthor: nodesOf(t.comments)[0]?.author?.login ?? undefined,
    }));
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
    body: pr?.body ?? "",
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
