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
//   - GITHUB_API_CONCURRENCY_MAX — global cap on active `github_api` steps
//                                  (protects against GitHub 429 / secondary
//                                  rate-limit storms across all repos).
//   - repo.concurrencyMax        — per-repo cap on active steps that count
//                                  against the repo (claude_skill, github_api,
//                                  wait_external).
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
  // repo dimension (`claude_skill`, `github_api`, `wait_external`).
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
  | { admit: true }
  | { admit: false; reason: AdmissionRejectReason };

// Does the given step type count against the per-repo concurrency cap?
// See vision §4.3 — `claude_skill`, `github_api`, and `wait_external` all
// count against the repo dimension; `decision` and `fork` do not.
function countsAgainstRepo(stepType: StepType): boolean {
  switch (stepType) {
    case StepType.ClaudeSkill:
    case StepType.GithubApi:
    case StepType.WaitExternal:
      return true;
    case StepType.Decision:
    case StepType.Fork:
      return false;
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
    case StepType.GithubApi:
      if (counts.systemGithubApi >= config.githubApiMax) {
        return {
          admit: false,
          reason: AdmissionRejectReason.SystemGithubApiFull,
        };
      }
      break;
    case StepType.WaitExternal:
      // No global cap — repo cap is the only constraint.
      break;
    case StepType.Decision:
    case StepType.Fork:
      // Unreachable: short-circuited above by countsAgainstRepo().
      break;
  }

  return { admit: true };
}
