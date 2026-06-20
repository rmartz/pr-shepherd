// ---------------------------------------------------------------------------
// State-axis enums + the flat `PrStateVector` (Epic 10, #96).
//
// A PR's interpreted state is decomposed into 8 orthogonal axes. Each axis is
// a string enum whose values match the serialized schema; members are kept in
// alphabetical order per the repo enum convention. The vector is the pure
// output of `derivePrState` — one enum value per axis, no I/O, no timestamps.
// ---------------------------------------------------------------------------

// Observational only — the activity axis is documented as NEVER feeding
// `decide()`. It exists for human dashboards (is this PR moving?), not gating.
export enum Activity {
  Active = "active",
  DelegatedWaiting = "delegated_waiting",
  Idle = "idle",
}

export enum CIState {
  Cancelled = "cancelled",
  CancelledRetried = "cancelled_retried",
  Failing = "failing",
  NeedsAuth = "needs_auth",
  Passed = "passed",
  Running = "running",
}

export enum CopilotState {
  AwaitingReview = "awaiting_review",
  HasOpenThreads = "has_open_threads",
  None = "none",
  Resolved = "resolved",
}

// The Dependabot rebase marker, derived from the PR body. Per the global
// CLAUDE.md, the "Dependabot is rebasing this PR" line is authoritative and
// current — a rebase is in progress, so the daemon must NOT post another
// `@dependabot rebase`. "Dependabot rebase failed" is the terminal failure
// state, where a `@dependabot recreate` is usually the right follow-up. None
// means no marker is present (no rebase running).
export enum DependabotRebaseState {
  Failed = "failed",
  InProgress = "in_progress",
  None = "none",
}

export enum HoldState {
  BlockedOnIssue = "blocked_on_issue",
  DoNotMerge = "do_not_merge",
  Draft = "draft",
  EscalationNeeded = "escalation_needed",
  None = "none",
  Wip = "wip",
}

export enum MergeConflict {
  Clean = "clean",
  Conflicting = "conflicting",
  Unknown = "unknown",
}

export enum ReviewState {
  Approved = "approved",
  AwaitingReReview = "awaiting_re_review",
  ChangesRequested = "changes_requested",
  Unreviewed = "unreviewed",
}

export enum ThreadState {
  NoneOpen = "none_open",
  Open = "open",
}

export enum UATState {
  DecisionPending = "decision_pending",
  NotRequired = "not_required",
  ReadyUntested = "ready_untested",
  Tested = "tested",
}

// One value per axis. Flat by design: a downstream `decide()` reads the axes
// independently, so there is no nesting or cross-axis coupling here.
export interface PrStateVector {
  activity: Activity;
  ci: CIState;
  conflict: MergeConflict;
  copilot: CopilotState;
  dependabotRebase: DependabotRebaseState;
  hold: HoldState;
  review: ReviewState;
  threads: ThreadState;
  uat: UATState;
}

// Optional pure context for the derivation. Kept data-only so derivation stays
// a deterministic transformation: the caller supplies the facts derivation
// cannot see in a single PR snapshot (e.g. whether a referenced blocking issue
// is still open), and derivation owns only the interpretation.
export interface DeriveContext {
  // Issue numbers that a `blocked on #N` marker may reference and that are
  // currently OPEN. A marker whose issue is absent from this set is treated as
  // resolved (auto-resume), so the hold clears the moment the issue closes.
  openIssueNumbers?: number[];
  // Logins/names whose pending work counts as "delegated" (e.g. a bot the
  // daemon handed the PR to). Used only by the observational Activity axis.
  // Matching is case-insensitive substring.
  delegateLogins?: string[];
  // Wall-clock "now" (ms epoch) for the Activity idle/active split. Defaults
  // to the snapshot's `fetchedAt` so derivation stays deterministic in tests.
  now?: number;
  // How long since the last activity before a PR is considered idle (ms).
  idleThresholdMs?: number;
}
