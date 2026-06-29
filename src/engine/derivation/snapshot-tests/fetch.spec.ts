import { describe, it, expect } from "vitest";
import { fetchPrSnapshot } from "../snapshot";
import { TARGET, makeTransport } from "./fixtures";

// ---------------------------------------------------------------------------
// Tests for the PR state snapshot fetcher. The fetcher issues ONE GraphQL
// read (metadata + commits + labels + a HEAD-only CI alias + review threads)
// and paginated REST reads for reviews and issue comments, returning a typed
// raw `PrSnapshot`. The transport is injected so tests script responses
// without real HTTP — mirroring the `GithubTransport` seam from #46.
// ---------------------------------------------------------------------------

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
