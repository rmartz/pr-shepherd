import { describe, it, expect } from "vitest";
import { GithubRateLimitError } from "@/engine/derivation";
import type { GhCommand, GhResult } from "./ghExec";
import { createGithubReadTransport } from "./readTransport";

// A fake `gh` exec returning a scripted result and (optionally) capturing the
// command it was invoked with, so the transport can be tested with no
// subprocess or network.
function execReturning(
  result: Partial<GhResult>,
  capture?: (command: GhCommand) => void,
): (command: GhCommand) => Promise<GhResult> {
  return (command: GhCommand): Promise<GhResult> => {
    capture?.(command);
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, ...result });
  };
}

describe("createGithubReadTransport.graphql", () => {
  it("sends { query, variables } on stdin and returns the unwrapped data", async () => {
    let command: GhCommand | undefined;
    const transport = createGithubReadTransport(
      execReturning(
        { stdout: JSON.stringify({ data: { repository: { id: "R1" } } }) },
        (c) => {
          command = c;
        },
      ),
    );

    const data = await transport.graphql("query($n:Int){x}", { n: 7 });

    expect(data).toEqual({ repository: { id: "R1" } });
    expect(command?.args).toEqual(["api", "graphql", "--input", "-"]);
    expect(command?.stdin).toBe(
      JSON.stringify({ query: "query($n:Int){x}", variables: { n: 7 } }),
    );
  });

  it("throws GithubRateLimitError on a rate-limited result", async () => {
    const transport = createGithubReadTransport(
      execReturning({ exitCode: 1, stderr: "API rate limit exceeded" }),
    );

    await expect(transport.graphql("q", {})).rejects.toBeInstanceOf(
      GithubRateLimitError,
    );
  });

  it("throws on GraphQL errors in the response body", async () => {
    const transport = createGithubReadTransport(
      execReturning({ stdout: JSON.stringify({ errors: [{ message: "x" }] }) }),
    );

    await expect(transport.graphql("q", {})).rejects.toThrow(/GraphQL errors/);
  });
});

describe("createGithubReadTransport.restPaginate", () => {
  it("runs gh api --paginate with encoded query params and returns the array", async () => {
    let command: GhCommand | undefined;
    const transport = createGithubReadTransport(
      execReturning({ stdout: JSON.stringify([{ id: 1 }, { id: 2 }]) }, (c) => {
        command = c;
      }),
    );

    const rows = await transport.restPaginate("/repos/o/r/pulls/7/reviews", {
      per_page: 100,
    });

    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(command?.args).toEqual([
      "api",
      "--paginate",
      "/repos/o/r/pulls/7/reviews?per_page=100",
    ]);
  });

  it("throws GithubRateLimitError on a rate-limited result", async () => {
    const transport = createGithubReadTransport(
      execReturning({
        exitCode: 1,
        stderr: "You have exceeded a secondary rate limit",
      }),
    );

    await expect(transport.restPaginate("/x")).rejects.toBeInstanceOf(
      GithubRateLimitError,
    );
  });
});
