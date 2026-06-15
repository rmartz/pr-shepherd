// Enums shared across collection schemas. Kept in alphabetical order to
// minimize merge conflicts when new values are added.

export enum RunStatus {
  Cancelled = "cancelled",
  Completed = "completed",
  Failed = "failed",
  Pending = "pending",
  Running = "running",
}

export enum StepStatus {
  Cancelled = "cancelled",
  Completed = "completed",
  Failed = "failed",
  Pending = "pending",
  Queued = "queued",
  Running = "running",
  Skipped = "skipped",
  Waiting = "waiting",
}

export enum StepType {
  ClaudeSkill = "claude_skill",
  Decision = "decision",
  Fork = "fork",
  GithubApi = "github_api",
  WaitAuthorPush = "wait_author_push",
  WaitExternal = "wait_external",
}
