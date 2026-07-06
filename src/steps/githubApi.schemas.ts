import { z } from "zod";

// --- Action types ----------------------------------------------------------

// Kept in alphabetical order to minimize merge conflicts.
export enum GithubActionType {
  AddLabel = "add_label",
  AuthorizeCi = "authorize_ci",
  PostComment = "post_comment",
  PostInlineComment = "post_inline_comment",
  PostReview = "post_review",
  RebaseDependabot = "rebase_dependabot",
  RemoveLabel = "remove_label",
  RequestSquashMerge = "request_squash_merge",
  ResolveThread = "resolve_thread",
  UpdateBranch = "update_branch",
}

// Per-action Zod schemas. The closed enum on `type` is the contract:
// unknown action types fail to parse at workflow-load time so the
// workflow loader (#47) catches them before any execution.

const RepoPrParams = z.object({
  repo: z.string().min(1),
  pr: z.number().int().nonnegative(),
});

const AddLabelSchema = z.object({
  type: z.literal(GithubActionType.AddLabel),
  params: RepoPrParams.extend({ label: z.string().min(1) }),
});

const AuthorizeCiSchema = z.object({
  type: z.literal(GithubActionType.AuthorizeCi),
  params: RepoPrParams,
});

const PostCommentSchema = z.object({
  type: z.literal(GithubActionType.PostComment),
  params: RepoPrParams.extend({ body: z.string() }),
});

const PostInlineCommentSchema = z.object({
  type: z.literal(GithubActionType.PostInlineComment),
  params: RepoPrParams.extend({
    file: z.string(),
    line: z.number().int().positive(),
    body: z.string(),
    // The HEAD commit SHA the inline comment anchors to. The REST API
    // (`POST .../pulls/{n}/comments`) requires `commit_id`, and the review
    // skill that emits this action already knows the PR's HEAD — so it supplies
    // it here rather than making the write transport re-fetch it (#290).
    commitId: z.string().min(1),
  }),
});

const PostReviewSchema = z.object({
  type: z.literal(GithubActionType.PostReview),
  params: RepoPrParams.extend({
    verdict: z.enum(["approved", "changes_requested", "commented"]),
    body: z.string(),
  }),
});

// Posts `@dependabot rebase`. `rebaseInProgress` carries the derived rebase
// marker (`context.state.dependabotRebase === "in_progress"`) so the guard
// rides along with the action — `post_comment` would strip it. When true, the
// executor no-ops instead of posting a redundant command while a rebase is
// already running (the marker is authoritative and current). Defaults to
// false so an action authored without the guard still posts.
const RebaseDependabotSchema = z.object({
  type: z.literal(GithubActionType.RebaseDependabot),
  params: RepoPrParams.extend({
    rebaseInProgress: z.boolean().default(false),
  }),
});

const RemoveLabelSchema = z.object({
  type: z.literal(GithubActionType.RemoveLabel),
  params: RepoPrParams.extend({ label: z.string().min(1) }),
});

const RequestSquashMergeSchema = z.object({
  type: z.literal(GithubActionType.RequestSquashMerge),
  params: RepoPrParams,
});

const ResolveThreadSchema = z.object({
  type: z.literal(GithubActionType.ResolveThread),
  params: z.object({ threadId: z.string().min(1) }),
});

const UpdateBranchSchema = z.object({
  type: z.literal(GithubActionType.UpdateBranch),
  params: RepoPrParams,
});

export const GithubActionSchema = z.discriminatedUnion("type", [
  AddLabelSchema,
  AuthorizeCiSchema,
  PostCommentSchema,
  PostInlineCommentSchema,
  PostReviewSchema,
  RebaseDependabotSchema,
  RemoveLabelSchema,
  RequestSquashMergeSchema,
  ResolveThreadSchema,
  UpdateBranchSchema,
]);
export type GithubAction = z.infer<typeof GithubActionSchema>;

export const GithubApiInputSchema = z.object({
  actions: z.array(GithubActionSchema),
});
export type GithubApiInput = z.infer<typeof GithubApiInputSchema>;
