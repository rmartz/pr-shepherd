import { describe, it, expect } from "vitest";
import { StepType } from "@/db/schemas";
import {
  canAdmitStep,
  AdmissionRejectReason,
  type ActiveCounts,
  type ConcurrencyConfig,
  type RepoConfig,
  type StepCandidate,
} from "./concurrency";

// ---------------------------------------------------------------------------
// Tests for the scheduler's admission decision — the pure function that
// answers "given current active counts and config, can this pending step be
// promoted to queued?". The decision is the heart of the scheduler loop in
// vision §4.2; the surrounding loop (DB reads, status transitions, executor
// spawning) is built on top of it in a later sub-issue.
//
// Three independent concurrency dimensions:
//   1. SYSTEM_CONCURRENCY_MAX  — global cap on active `claude_skill` steps
//   2. GITHUB_API_CONCURRENCY_MAX — global cap on active `github_api` steps
//   3. repo.concurrencyMax     — per-repo cap on active steps that count
//                                 against the repo (claude_skill, github_api,
//                                 wait_external)
// Decision/fork steps are zero-cost and admitted unconditionally.
// ---------------------------------------------------------------------------

function makeConfig(
  overrides: Partial<ConcurrencyConfig> = {},
): ConcurrencyConfig {
  return {
    systemMax: 8,
    githubApiMax: 4,
    defaultRepoMax: 2,
    ...overrides,
  };
}

function makeCounts(overrides: Partial<ActiveCounts> = {}): ActiveCounts {
  return {
    systemClaude: 0,
    systemGithubApi: 0,
    perRepo: new Map(),
    ...overrides,
  };
}

function makeCandidate(
  stepType: StepType,
  repoId = "owner/repo-a",
): StepCandidate {
  return { stepType, repoId };
}

function makeRepoConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    id: "owner/repo-a",
    concurrencyMax: 2,
    ...overrides,
  };
}

describe("Scheduler tracks active github_api steps system-wide independently of Claude global + repo dimensions", () => {
  it("admits a github_api step when the GitHub-API system count is below the cap", () => {
    const decision = canAdmitStep(
      makeCandidate(StepType.GithubApi),
      makeCounts({ systemGithubApi: 3 }),
      makeConfig({ githubApiMax: 4 }),
      makeRepoConfig(),
    );
    expect(decision.admit).toBe(true);
  });

  it("admits a github_api step even when the Claude system count is full", () => {
    // The Claude global cap is exhausted (claude_skill saturates SystemMax)
    // but the GitHub-API dimension is independent, so the step admits.
    const decision = canAdmitStep(
      makeCandidate(StepType.GithubApi),
      makeCounts({ systemClaude: 8, systemGithubApi: 0 }),
      makeConfig({ systemMax: 8, githubApiMax: 4 }),
      makeRepoConfig(),
    );
    expect(decision.admit).toBe(true);
  });
});

describe("A github_api step is admitted only when active_github_api_count < githubApiMax", () => {
  it("rejects a github_api step when the GitHub-API global count equals the cap", () => {
    const decision = canAdmitStep(
      makeCandidate(StepType.GithubApi),
      makeCounts({ systemGithubApi: 4 }),
      makeConfig({ githubApiMax: 4 }),
      makeRepoConfig(),
    );
    expect(decision.admit).toBe(false);
    if (!decision.admit) {
      expect(decision.reason).toBe(AdmissionRejectReason.SystemGithubApiFull);
    }
  });

  it("rejects a github_api step when the GitHub-API global count exceeds the cap (defensive)", () => {
    const decision = canAdmitStep(
      makeCandidate(StepType.GithubApi),
      makeCounts({ systemGithubApi: 5 }),
      makeConfig({ githubApiMax: 4 }),
      makeRepoConfig(),
    );
    expect(decision.admit).toBe(false);
  });

  it("releases a previously-held github_api step when an active call completes", () => {
    // Same candidate, same config — only the active count drops. The decision
    // flips from reject to admit, modelling the post-completion release.
    const candidate = makeCandidate(StepType.GithubApi);
    const config = makeConfig({ githubApiMax: 4 });
    const repoConfig = makeRepoConfig();
    const before = canAdmitStep(
      candidate,
      makeCounts({ systemGithubApi: 4 }),
      config,
      repoConfig,
    );
    expect(before.admit).toBe(false);
    const after = canAdmitStep(
      candidate,
      makeCounts({ systemGithubApi: 3 }),
      config,
      repoConfig,
    );
    expect(after.admit).toBe(true);
  });
});

describe("github_api steps still count against the per-repo concurrencyMax", () => {
  it("rejects a github_api step when the repo is at its per-repo cap", () => {
    const decision = canAdmitStep(
      makeCandidate(StepType.GithubApi, "owner/repo-a"),
      makeCounts({
        systemGithubApi: 0,
        perRepo: new Map([["owner/repo-a", 2]]),
      }),
      makeConfig({ githubApiMax: 4 }),
      makeRepoConfig({ id: "owner/repo-a", concurrencyMax: 2 }),
    );
    expect(decision.admit).toBe(false);
    if (!decision.admit) {
      expect(decision.reason).toBe(AdmissionRejectReason.RepoFull);
    }
  });

  it("admits a github_api step in a different repo even when one repo is full", () => {
    // Per-repo budgets are independent — repo-a being full does not block
    // repo-b.
    const decision = canAdmitStep(
      makeCandidate(StepType.GithubApi, "owner/repo-b"),
      makeCounts({
        perRepo: new Map([
          ["owner/repo-a", 2],
          ["owner/repo-b", 0],
        ]),
      }),
      makeConfig(),
      makeRepoConfig({ id: "owner/repo-b", concurrencyMax: 2 }),
    );
    expect(decision.admit).toBe(true);
  });

  it("uses defaultRepoMax when no per-repo override is provided", () => {
    const decision = canAdmitStep(
      makeCandidate(StepType.GithubApi, "owner/repo-c"),
      makeCounts({ perRepo: new Map([["owner/repo-c", 3]]) }),
      makeConfig({ defaultRepoMax: 3 }),
      // No repoConfig argument
    );
    expect(decision.admit).toBe(false);
  });
});

describe("github_api steps do NOT count against SYSTEM_CONCURRENCY_MAX (Claude cap)", () => {
  it("admits many github_api steps even when systemMax is small", () => {
    const decision = canAdmitStep(
      makeCandidate(StepType.GithubApi),
      makeCounts({ systemClaude: 0, systemGithubApi: 0 }),
      makeConfig({ systemMax: 1, githubApiMax: 16 }),
      makeRepoConfig({ concurrencyMax: 16 }),
    );
    expect(decision.admit).toBe(true);
  });

  it("rejects claude_skill when systemMax is full, regardless of GitHub-API state", () => {
    const decision = canAdmitStep(
      makeCandidate(StepType.ClaudeSkill),
      makeCounts({ systemClaude: 8, systemGithubApi: 0 }),
      makeConfig({ systemMax: 8 }),
      makeRepoConfig(),
    );
    expect(decision.admit).toBe(false);
    if (!decision.admit) {
      expect(decision.reason).toBe(AdmissionRejectReason.SystemClaudeFull);
    }
  });

  it("rejects claude_skill when systemMax is full even if githubApiMax has capacity", () => {
    const decision = canAdmitStep(
      makeCandidate(StepType.ClaudeSkill),
      makeCounts({ systemClaude: 8, systemGithubApi: 0 }),
      makeConfig({ systemMax: 8, githubApiMax: 4 }),
      makeRepoConfig(),
    );
    expect(decision.admit).toBe(false);
  });
});

describe("Cost-free step types are admitted regardless of any capacity", () => {
  it("admits a decision step even when every dimension is full", () => {
    const decision = canAdmitStep(
      makeCandidate(StepType.Decision),
      makeCounts({
        systemClaude: 8,
        systemGithubApi: 4,
        perRepo: new Map([["owner/repo-a", 2]]),
      }),
      makeConfig({ systemMax: 8, githubApiMax: 4 }),
      makeRepoConfig({ concurrencyMax: 2 }),
    );
    expect(decision.admit).toBe(true);
  });

  it("admits a fork step even when every dimension is full", () => {
    const decision = canAdmitStep(
      makeCandidate(StepType.Fork),
      makeCounts({
        systemClaude: 8,
        systemGithubApi: 4,
        perRepo: new Map([["owner/repo-a", 2]]),
      }),
      makeConfig(),
      makeRepoConfig({ concurrencyMax: 2 }),
    );
    expect(decision.admit).toBe(true);
  });
});

describe("Defensive guards", () => {
  it("throws when an unknown StepType bypasses the type system", () => {
    // Simulate an unknown enum value reaching the function via type
    // assertion (or e.g. a DB row from a future schema version
    // deserialized without strict validation). The exhaustiveness
    // guard must throw rather than silently treating the step as
    // zero-cost.
    const candidate = {
      stepType: "telepathy" as StepType,
      repoId: "owner/repo-a",
    };
    expect(() =>
      canAdmitStep(candidate, makeCounts(), makeConfig(), makeRepoConfig()),
    ).toThrow(/Unknown step type/);
  });

  it("throws when RepoConfig.id does not match the candidate's repo", () => {
    // Always a caller bug — would silently apply the wrong repo's cap.
    expect(() =>
      canAdmitStep(
        makeCandidate(StepType.GithubApi, "owner/repo-a"),
        makeCounts(),
        makeConfig(),
        makeRepoConfig({ id: "owner/repo-b" }),
      ),
    ).toThrow(/does not match candidate repo/);
  });

  it("does not validate RepoConfig when none is supplied (defaultRepoMax path)", () => {
    // No RepoConfig → no validation; behavior falls back to
    // defaultRepoMax as documented.
    const decision = canAdmitStep(
      makeCandidate(StepType.GithubApi, "owner/repo-d"),
      makeCounts(),
      makeConfig({ defaultRepoMax: 2 }),
      // repoConfig omitted
    );
    expect(decision.admit).toBe(true);
  });
});

describe("wait_external steps count against the repo only", () => {
  it("admits a wait_external step when the repo has capacity", () => {
    const decision = canAdmitStep(
      makeCandidate(StepType.WaitExternal),
      makeCounts({
        systemClaude: 8,
        systemGithubApi: 4,
        perRepo: new Map([["owner/repo-a", 1]]),
      }),
      makeConfig({ systemMax: 8, githubApiMax: 4 }),
      makeRepoConfig({ concurrencyMax: 2 }),
    );
    // Both system caps are exhausted but wait_external does not count against
    // either; the repo still has 1 of 2 slots free.
    expect(decision.admit).toBe(true);
  });

  it("rejects a wait_external step when the repo is at its cap", () => {
    const decision = canAdmitStep(
      makeCandidate(StepType.WaitExternal),
      makeCounts({ perRepo: new Map([["owner/repo-a", 2]]) }),
      makeConfig(),
      makeRepoConfig({ concurrencyMax: 2 }),
    );
    expect(decision.admit).toBe(false);
    if (!decision.admit) {
      expect(decision.reason).toBe(AdmissionRejectReason.RepoFull);
    }
  });
});
