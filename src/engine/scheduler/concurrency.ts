import { StepType } from "@/db/schemas";

// ---------------------------------------------------------------------------
// Scheduler admission decision.
//
// The scheduler loop in vision §4.2 promotes `pending` step instances to
// `queued` one by one. For each candidate, this module answers:
//
//   "Given the current active counts and config, can this step be admitted?"
//
// Three independent concurrency dimensions are evaluated:
//
//   - SYSTEM_CONCURRENCY_MAX     — global cap on active `claude_skill` steps
//                                  (protects local Claude CLI throughput).
//   - GITHUB_API_CONCURRENCY_MAX — global cap on active GitHub-reading/writing
//                                  steps (`github_api`, `derive_pr_state`)
//                                  (protects against GitHub 429 / secondary
//                                  rate-limit storms across all repos).
//   - repo.concurrencyMax        — per-repo cap on active steps that count
//                                  against the repo (claude_skill,
//                                  derive_pr_state, github_api,
//                                  wait_author_push, wait_external).
//
// Cost-free step types (`decision`, `fork`) are admitted unconditionally —
// they execute in-process and consume no external resources.
//
// This module is intentionally a pure function over plain data: callers own
// the active counts (typically derived from a Db query for `running` steps)
// and apply the decision externally. See vision §4.3 for the per-stepType
// cost matrix and the rationale for keeping global Claude and global GitHub
// dimensions independent.
// ---------------------------------------------------------------------------

export interface ConcurrencyConfig {
  // Max simultaneous Claude invocations across all repos. Reserved for
  // `claude_skill` steps only.
  systemMax: number;
  // Max simultaneous GitHub API calls across all repos. Reserved for
  // `github_api` steps only. New as of issue #45.
  githubApiMax: number;
  // Default per-repo cap when a repository does not declare its own
  // `concurrencyMax`. Applies to any step type that counts against the
  // repo dimension (`claude_skill`, `github_api`, `wait_author_push`,
  // `wait_external`).
  defaultRepoMax: number;
}

export interface RepoConfig {
  id: string;
  concurrencyMax: number;
}

export interface ActiveCounts {
  // Active `claude_skill` steps system-wide.
  systemClaude: number;
  // Active `github_api` steps system-wide.
  systemGithubApi: number;
  // Active step count per repo (any step type that counts against the
  // repo dimension). Missing entries are treated as 0.
  perRepo: Map<string, number>;
}

export interface StepCandidate {
  stepType: StepType;
  repoId: string;
}

export enum AdmissionRejectReason {
  RepoFull = "repo_full",
  SystemClaudeFull = "system_claude_full",
  SystemGithubApiFull = "system_github_api_full",
}

export type AdmissionDecision =
  { admit: true } | { admit: false; reason: AdmissionRejectReason };

// Does the given step type count against the per-repo concurrency cap?
// See vision §4.3 — `claude_skill`, `github_api`, `wait_author_push`, and
// `wait_external` all count against the repo dimension; `decision` and `fork`
// do not.
//
// Exported so the scheduler loop (#55) can apply the same cost matrix
// when deriving `ActiveCounts` and when incrementally updating counts
// after admission decisions within a single tick.
export function countsAgainstRepo(stepType: StepType): boolean {
  switch (stepType) {
    case StepType.ClaudeSkill:
    case StepType.DerivePrState:
    case StepType.GithubApi:
    case StepType.WaitAuthorPush:
    case StepType.WaitExternal:
      return true;
    case StepType.Decision:
    case StepType.Fork:
      return false;
    default: {
      // Exhaustiveness guard: a new `StepType` value must add an
      // explicit case above. Without this, an unknown value (e.g. an
      // older DB row deserialized without strict schema validation)
      // would fall through and silently return `undefined`, which the
      // caller's `if (!countsAgainstRepo(...))` would treat as
      // zero-cost — a silent bypass of every concurrency cap.
      const _exhaustive: never = stepType;
      throw new Error(
        `Unknown step type for concurrency check: ${String(_exhaustive)}`,
      );
    }
  }
}

export function canAdmitStep(
  candidate: StepCandidate,
  counts: ActiveCounts,
  config: ConcurrencyConfig,
  repoConfig?: RepoConfig,
): AdmissionDecision {
  // Cost-free step types short-circuit the rest of the checks: they are
  // executed in-process and consume no global or per-repo slots.
  if (!countsAgainstRepo(candidate.stepType)) {
    return { admit: true };
  }

  // Defensive check: when a per-repo override is supplied, its `id` must
  // match the candidate's repo. A mismatch is always a caller bug (e.g.
  // fetching the wrong index from `repositories[]` in config.yaml) and
  // would silently apply the wrong repo's cap. Fail loudly here rather
  // than letting the mismatch leak into the scheduler's decision.
  if (repoConfig !== undefined && repoConfig.id !== candidate.repoId) {
    throw new Error(
      `RepoConfig id "${repoConfig.id}" does not match candidate repo "${candidate.repoId}".`,
    );
  }

  const repoMax = repoConfig?.concurrencyMax ?? config.defaultRepoMax;
  const repoActive = counts.perRepo.get(candidate.repoId) ?? 0;
  if (repoActive >= repoMax) {
    return { admit: false, reason: AdmissionRejectReason.RepoFull };
  }

  // Per-step-type global caps. The dimensions are independent — a candidate
  // checks only the cap that applies to its type.
  switch (candidate.stepType) {
    case StepType.ClaudeSkill:
      if (counts.systemClaude >= config.systemMax) {
        return { admit: false, reason: AdmissionRejectReason.SystemClaudeFull };
      }
      break;
    case StepType.DerivePrState:
    case StepType.GithubApi:
      // Both perform a GitHub read/write and so draw from the shared
      // GitHub-API budget that protects against 429 / secondary-rate-limit
      // storms across all repos.
      if (counts.systemGithubApi >= config.githubApiMax) {
        return {
          admit: false,
          reason: AdmissionRejectReason.SystemGithubApiFull,
        };
      }
      break;
    case StepType.WaitExternal:
    case StepType.WaitAuthorPush:
      // No global cap — repo cap is the only constraint.
      break;
    case StepType.Decision:
    case StepType.Fork:
      // Unreachable: short-circuited above by countsAgainstRepo().
      break;
  }

  return { admit: true };
}
