import { GithubActionType, type GithubAction } from "@/steps/githubApi";
import type { GhCommand } from "./ghExec";

// ---------------------------------------------------------------------------
// GitHub action → `gh` command mapping (issue #290, write transport).
//
// Pure: maps one single-call `GithubAction` to the `gh` invocation that
// performs it. `authorize_ci` is excluded — it is multi-step (discover the
// runs awaiting approval for the PR HEAD, then approve each) and lives in the
// transport, not here.
//
// String fields use `-f` (raw-field), never `-F`: `-F` interprets a leading
// `@` as "read from file", which would corrupt bodies like `@dependabot rebase`
// or a label/comment that happens to start with `@`. Only the numeric `line`
// uses `-F` so `gh` sends it as an integer.
// ---------------------------------------------------------------------------

// Any action the transport dispatches through a single `gh` call.
export type SingleCallAction = Exclude<
  GithubAction,
  { type: GithubActionType.AuthorizeCi }
>;

const REVIEW_EVENT: Record<
  "approved" | "changes_requested" | "commented",
  string
> = {
  approved: "APPROVE",
  changes_requested: "REQUEST_CHANGES",
  commented: "COMMENT",
};

const RESOLVE_THREAD_MUTATION =
  "mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id}}}";

export function buildActionCommand(action: SingleCallAction): GhCommand {
  switch (action.type) {
    case GithubActionType.AddLabel: {
      const { repo, pr, label } = action.params;
      return {
        args: [
          "api",
          "--method",
          "POST",
          `repos/${repo}/issues/${String(pr)}/labels`,
          "-f",
          `labels[]=${label}`,
        ],
      };
    }
    case GithubActionType.RemoveLabel: {
      const { repo, pr, label } = action.params;
      return {
        args: [
          "api",
          "--method",
          "DELETE",
          `repos/${repo}/issues/${String(pr)}/labels/${encodeURIComponent(label)}`,
        ],
      };
    }
    case GithubActionType.PostComment: {
      const { repo, pr, body } = action.params;
      return {
        args: [
          "api",
          "--method",
          "POST",
          `repos/${repo}/issues/${String(pr)}/comments`,
          "-f",
          `body=${body}`,
        ],
      };
    }
    case GithubActionType.RebaseDependabot: {
      // The `rebaseInProgress` guard is applied by the executor before the
      // transport is reached, so here we always post the command comment.
      const { repo, pr } = action.params;
      return {
        args: [
          "api",
          "--method",
          "POST",
          `repos/${repo}/issues/${String(pr)}/comments`,
          "-f",
          "body=@dependabot rebase",
        ],
      };
    }
    case GithubActionType.PostInlineComment: {
      const { repo, pr, body, commitId, file, line } = action.params;
      return {
        args: [
          "api",
          "--method",
          "POST",
          `repos/${repo}/pulls/${String(pr)}/comments`,
          "-f",
          `body=${body}`,
          "-f",
          `commit_id=${commitId}`,
          "-f",
          `path=${file}`,
          "-F",
          `line=${String(line)}`,
          "-f",
          "side=RIGHT",
        ],
      };
    }
    case GithubActionType.PostReview: {
      const { repo, pr, verdict, body } = action.params;
      return {
        args: [
          "api",
          "--method",
          "POST",
          `repos/${repo}/pulls/${String(pr)}/reviews`,
          "-f",
          `event=${REVIEW_EVENT[verdict]}`,
          "-f",
          `body=${body}`,
        ],
      };
    }
    case GithubActionType.RequestSquashMerge: {
      const { repo, pr } = action.params;
      return {
        args: [
          "api",
          "--method",
          "PUT",
          `repos/${repo}/pulls/${String(pr)}/merge`,
          "-f",
          "merge_method=squash",
        ],
      };
    }
    case GithubActionType.UpdateBranch: {
      const { repo, pr } = action.params;
      return {
        args: [
          "api",
          "--method",
          "PUT",
          `repos/${repo}/pulls/${String(pr)}/update-branch`,
        ],
      };
    }
    case GithubActionType.ResolveThread: {
      return {
        args: ["api", "graphql", "--input", "-"],
        stdin: JSON.stringify({
          query: RESOLVE_THREAD_MUTATION,
          variables: { threadId: action.params.threadId },
        }),
      };
    }
  }
}
