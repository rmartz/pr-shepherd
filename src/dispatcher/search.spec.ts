import { describe, expect, it } from "vitest";
import type { GhCommand, GhResult } from "@/github/ghExec";
import { searchPullRequests } from "./search";

function makePage(numbers: number[], endCursor: string | undefined): GhResult {
  return {
    exitCode: 0,
    stderr: "",
    stdout: JSON.stringify({
      data: {
        search: {
          pageInfo: {
            hasNextPage: endCursor !== undefined,
            endCursor: endCursor ?? null,
          },
          nodes: numbers.map((number) => ({
            number,
            url: `https://github.com/rmartz/group-picks/pull/${String(number)}`,
            headRefOid: `sha${String(number)}`,
            repository: {
              name: "group-picks",
              nameWithOwner: "rmartz/group-picks",
            },
          })),
        },
      },
    }),
  };
}

describe("searchPullRequests", () => {
  it("maps PR nodes to search hits", async () => {
    const gh = () => Promise.resolve(makePage([500], undefined));
    const hits = await searchPullRequests(gh, "label:approved");
    expect(hits).toEqual([
      {
        repo: "rmartz/group-picks",
        repoName: "group-picks",
        number: 500,
        headSha: "sha500",
        url: "https://github.com/rmartz/group-picks/pull/500",
      },
    ]);
  });

  it("follows the page cursor", async () => {
    const pages = [makePage([1], "c1"), makePage([2], undefined)];
    const cursors: unknown[] = [];
    const gh = (command: GhCommand) => {
      const body = JSON.parse(command.stdin ?? "{}") as {
        variables: { cursor?: string };
      };
      cursors.push(body.variables.cursor);
      return Promise.resolve(
        pages[cursors.length - 1] ?? makePage([], undefined),
      );
    };
    const hits = await searchPullRequests(gh, "label:approved");
    expect(hits.map((hit) => hit.number)).toEqual([1, 2]);
  });

  it("throws on a gh failure", async () => {
    const gh = () =>
      Promise.resolve({ exitCode: 1, stdout: "", stderr: "HTTP 502" });
    await expect(searchPullRequests(gh, "label:approved")).rejects.toThrow(
      "HTTP 502",
    );
  });
});
