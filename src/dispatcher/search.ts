import { z } from "zod";
import type { GhExec } from "@/github/ghExec";

// ---------------------------------------------------------------------------
// Global PR search (issue #413) — one GraphQL `search` per dispatch rule,
// spanning every repository the query matches rather than a single repo.
// ---------------------------------------------------------------------------

export interface PrSearchHit {
  // `owner/name`, e.g. `rmartz/trip-split`.
  repo: string;
  // Bare repository name, used to locate the local checkout.
  repoName: string;
  number: number;
  headSha: string;
  url: string;
}

const SEARCH_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        url
        headRefOid
        repository { name nameWithOwner }
      }
    }
  }
}`;

const SearchResponseSchema = z.object({
  data: z.object({
    search: z.object({
      pageInfo: z.object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullable(),
      }),
      // Non-PR nodes (never expected with `is:pr`) deserialize as `{}`.
      nodes: z.array(
        z.union([
          z.object({
            number: z.number(),
            url: z.string(),
            headRefOid: z.string(),
            repository: z.object({
              name: z.string(),
              nameWithOwner: z.string(),
            }),
          }),
          z.object({}).strict(),
        ]),
      ),
    }),
  }),
});

// Upper bound on pages fetched per query (50 PRs each), so a malformed query
// that matches far too much cannot page forever.
const MAX_PAGES = 4;

export async function searchPullRequests(
  gh: GhExec,
  query: string,
): Promise<PrSearchHit[]> {
  const hits: PrSearchHit[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await gh({
      args: ["api", "graphql", "--input", "-"],
      stdin: JSON.stringify({
        query: SEARCH_QUERY,
        variables: { q: query, cursor },
      }),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `gh search failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`,
      );
    }
    const { search } = SearchResponseSchema.parse(
      JSON.parse(result.stdout),
    ).data;
    for (const node of search.nodes) {
      if ("number" in node) {
        hits.push({
          repo: node.repository.nameWithOwner,
          repoName: node.repository.name,
          number: node.number,
          headSha: node.headRefOid,
          url: node.url,
        });
      }
    }
    if (!search.pageInfo.hasNextPage || !search.pageInfo.endCursor) break;
    cursor = search.pageInfo.endCursor;
  }
  return hits;
}
