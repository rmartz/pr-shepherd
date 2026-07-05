import { describe, it, expect } from "vitest";
import { GithubActionType } from "@/steps/githubApi";
import type { GhCommand, GhResult } from "./ghExec";
import { createGithubWriteTransport } from "./writeTransport";

// A fake `gh` exec whose result is computed per command, so both result mapping
// and the multi-step `authorize_ci` can be tested with no subprocess.
function execScript(
  handler: (command: GhCommand) => Partial<GhResult>,
): (command: GhCommand) => Promise<GhResult> {
  return (command: GhCommand): Promise<GhResult> =>
    Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: 0,
      ...handler(command),
    });
}

describe("createGithubWriteTransport maps gh results to transport results", () => {
  it("returns ok with the parsed response body on success", async () => {
    const transport = createGithubWriteTransport(
      execScript(() => ({ stdout: JSON.stringify({ merged: true }) })),
    );

    const result = await transport.call({
      type: GithubActionType.RequestSquashMerge,
      params: { repo: "o/r", pr: 7 },
    });

    expect(result).toEqual({ kind: "ok", data: { merged: true } });
  });

  it("returns rate_limited on a rate-limited result", async () => {
    const transport = createGithubWriteTransport(
      execScript(() => ({ exitCode: 1, stderr: "API rate limit exceeded" })),
    );

    const result = await transport.call({
      type: GithubActionType.UpdateBranch,
      params: { repo: "o/r", pr: 7 },
    });

    expect(result).toEqual({ kind: "rate_limited" });
  });

  it("wraps a JSON array response under { value } to preserve record shape", async () => {
    const transport = createGithubWriteTransport(
      execScript(() => ({ stdout: JSON.stringify([1, 2, 3]) })),
    );

    const result = await transport.call({
      type: GithubActionType.RequestSquashMerge,
      params: { repo: "o/r", pr: 7 },
    });

    expect(result).toEqual({ kind: "ok", data: { value: [1, 2, 3] } });
  });

  it("returns a non-retriable error when exec rejects (e.g. spawn failure)", async () => {
    const transport = createGithubWriteTransport(() =>
      Promise.reject(new Error("spawn ENOENT")),
    );

    const result = await transport.call({
      type: GithubActionType.UpdateBranch,
      params: { repo: "o/r", pr: 7 },
    });

    expect(result).toMatchObject({
      kind: "error",
      message: "spawn ENOENT",
      retriable: false,
    });
  });

  it("marks a 4xx failure non-retriable and a 5xx failure retriable", async () => {
    const notFound = createGithubWriteTransport(
      execScript(() => ({ exitCode: 1, stderr: "gh: Not Found (HTTP 404)" })),
    );
    const serverError = createGithubWriteTransport(
      execScript(() => ({ exitCode: 1, stderr: "gh: Bad Gateway (HTTP 502)" })),
    );
    const action = {
      type: GithubActionType.UpdateBranch,
      params: { repo: "o/r", pr: 7 },
    } as const;

    expect(await notFound.call(action)).toMatchObject({
      kind: "error",
      retriable: false,
    });
    expect(await serverError.call(action)).toMatchObject({
      kind: "error",
      retriable: true,
    });
  });
});

describe("createGithubWriteTransport authorize_ci", () => {
  it("reads the head sha, lists action_required runs, and approves each", async () => {
    const seen: string[][] = [];
    const transport = createGithubWriteTransport((command) => {
      seen.push(command.args);
      if (command.args.includes(".head.sha")) {
        return Promise.resolve({ stdout: "abc123\n", stderr: "", exitCode: 0 });
      }
      if (command.args.some((arg) => arg.includes("action_required"))) {
        return Promise.resolve({
          stdout: "111\n222\n",
          stderr: "",
          exitCode: 0,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    });

    const result = await transport.call({
      type: GithubActionType.AuthorizeCi,
      params: { repo: "o/r", pr: 7 },
    });

    expect(result).toEqual({
      kind: "ok",
      data: { approvedRunIds: ["111", "222"] },
    });
    const approvals = seen.filter((args) => args.includes("--method"));
    expect(approvals.map((args) => args[args.length - 1])).toEqual([
      "repos/o/r/actions/runs/111/approve",
      "repos/o/r/actions/runs/222/approve",
    ]);
  });

  it("returns a non-retriable error when exec rejects mid-flow", async () => {
    const transport = createGithubWriteTransport((command) => {
      if (command.args.includes(".head.sha")) {
        return Promise.resolve({ stdout: "abc123\n", stderr: "", exitCode: 0 });
      }
      return Promise.reject(new Error("spawn ENOENT"));
    });

    const result = await transport.call({
      type: GithubActionType.AuthorizeCi,
      params: { repo: "o/r", pr: 7 },
    });

    expect(result).toMatchObject({
      kind: "error",
      message: "spawn ENOENT",
      retriable: false,
    });
  });

  it("short-circuits to rate_limited when a step is rate-limited", async () => {
    const transport = createGithubWriteTransport((command) => {
      if (command.args.includes(".head.sha")) {
        return Promise.resolve({ stdout: "abc", stderr: "", exitCode: 0 });
      }
      return Promise.resolve({
        stdout: "",
        stderr: "You have exceeded a secondary rate limit",
        exitCode: 1,
      });
    });

    const result = await transport.call({
      type: GithubActionType.AuthorizeCi,
      params: { repo: "o/r", pr: 7 },
    });

    expect(result).toEqual({ kind: "rate_limited" });
  });
});
