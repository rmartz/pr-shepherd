// Enums shared across collection schemas. Kept in alphabetical order to
// minimize merge conflicts when new values are added.

// Lifecycle of a UI-issued command document in the `commands` collection.
// A command is created `Pending`; the daemon's listener applies it and moves
// it to `Handled` (applied) or `Failed` (unknown type / malformed / target
// missing). The terminal states are what make re-delivery idempotent: the
// listener only ever acts on a `Pending` command.
export enum CommandStatus {
  Failed = "failed",
  Handled = "handled",
  Pending = "pending",
}

// The operator control actions the UI can issue to the daemon (ARCHITECTURE.md
// "Operator → daemon control plane"). Each maps to one effect the listener
// applies to the targeted run/step.
export enum CommandType {
  ForceRetryStep = "force_retry_step",
  PauseRun = "pause_run",
  ResumeRun = "resume_run",
}

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
  DerivePrState = "derive_pr_state",
  Fork = "fork",
  GithubApi = "github_api",
  WaitAuthorPush = "wait_author_push",
  WaitExternal = "wait_external",
}
