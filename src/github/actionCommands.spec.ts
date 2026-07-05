import { describe, it, expect } from "vitest";
import { GithubActionType } from "@/steps/githubApi";
import { buildActionCommand } from "./actionCommands";

// The gh flag mappings are the risky part of the write transport (a wrong flag
// fails silently against live GitHub), so every single-call action's command is
// pinned here.

describe("buildActionCommand", () => {
  it("maps add_label to a POST on the issue labels endpoint", () => {
    expect(
      buildActionCommand({
        type: GithubActionType.AddLabel,
        params: { repo: "o/r", pr: 7, label: "approved" },
      }).args,
    ).toEqual([
      "api",
      "--method",
      "POST",
      "repos/o/r/issues/7/labels",
      "-f",
      "labels[]=approved",
    ]);
  });

  it("url-encodes the label in a remove_label DELETE", () => {
    expect(
      buildActionCommand({
        type: GithubActionType.RemoveLabel,
        params: { repo: "o/r", pr: 7, label: "changes requested" },
      }).args,
    ).toEqual([
      "api",
      "--method",
      "DELETE",
      "repos/o/r/issues/7/labels/changes%20requested",
    ]);
  });

  it("posts a raw body for post_comment", () => {
    expect(
      buildActionCommand({
        type: GithubActionType.PostComment,
        params: { repo: "o/r", pr: 7, body: "hello" },
      }).args,
    ).toEqual([
      "api",
      "--method",
      "POST",
      "repos/o/r/issues/7/comments",
      "-f",
      "body=hello",
    ]);
  });

  it("posts the literal @dependabot rebase command for rebase_dependabot", () => {
    expect(
      buildActionCommand({
        type: GithubActionType.RebaseDependabot,
        params: { repo: "o/r", pr: 7, rebaseInProgress: false },
      }).args,
    ).toContain("body=@dependabot rebase");
  });

  it("includes commit_id, path, line and side for post_inline_comment", () => {
    expect(
      buildActionCommand({
        type: GithubActionType.PostInlineComment,
        params: {
          repo: "o/r",
          pr: 7,
          file: "a.ts",
          line: 12,
          body: "nit",
          commitId: "abc123",
        },
      }).args,
    ).toEqual([
      "api",
      "--method",
      "POST",
      "repos/o/r/pulls/7/comments",
      "-f",
      "body=nit",
      "-f",
      "commit_id=abc123",
      "-f",
      "path=a.ts",
      "-F",
      "line=12",
      "-f",
      "side=RIGHT",
    ]);
  });

  it("maps a post_review verdict to its review event", () => {
    expect(
      buildActionCommand({
        type: GithubActionType.PostReview,
        params: { repo: "o/r", pr: 7, verdict: "changes_requested", body: "x" },
      }).args,
    ).toContain("event=REQUEST_CHANGES");
  });

  it("PUTs the merge endpoint with merge_method=squash for request_squash_merge", () => {
    expect(
      buildActionCommand({
        type: GithubActionType.RequestSquashMerge,
        params: { repo: "o/r", pr: 7 },
      }).args,
    ).toEqual([
      "api",
      "--method",
      "PUT",
      "repos/o/r/pulls/7/merge",
      "-f",
      "merge_method=squash",
    ]);
  });

  it("PUTs update-branch for update_branch", () => {
    expect(
      buildActionCommand({
        type: GithubActionType.UpdateBranch,
        params: { repo: "o/r", pr: 7 },
      }).args,
    ).toEqual(["api", "--method", "PUT", "repos/o/r/pulls/7/update-branch"]);
  });

  it("sends the resolveReviewThread mutation on stdin for resolve_thread", () => {
    const command = buildActionCommand({
      type: GithubActionType.ResolveThread,
      params: { threadId: "PRRT_1" },
    });

    expect(command.args).toEqual(["api", "graphql", "--input", "-"]);
    expect(command.stdin).toContain("resolveReviewThread");
    expect(command.stdin).toContain("PRRT_1");
  });
});
