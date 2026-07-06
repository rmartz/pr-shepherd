import { StepType } from "@/db/schemas";
import type { Db } from "@/db/types";
import type { GithubReadTransport } from "@/engine/derivation";
import { createRunner, type Runner } from "@/engine/runner";
import { createClaudeSkillExecutor } from "@/steps/claudeSkill";
import { createDerivePrStateExecutor } from "@/steps/derivePrState";
import { evaluateGatesExecutor } from "@/steps/evaluateGates";
import { createForkExecutor, type FirstStepSpec } from "@/steps/fork";
import {
  createGithubApiExecutor,
  type GithubTransport,
} from "@/steps/githubApi";
import { createWaitAuthorPushExecutor } from "@/steps/waitAuthorPush";
import { createWaitExternalExecutor } from "@/steps/waitExternal";

// ---------------------------------------------------------------------------
// Executor-registry assembly (issue #290) — the composition point that turns
// the tested parts (step executors, GitHub transports, workflow registry) into
// a `Runner` with every `StepType` wired to its production executor. The daemon
// constructs this once at startup and drives the execution tick with it.
//
// `StepType.Decision` maps to `evaluateGatesExecutor`: the only decision-type
// step any workflow defines is `evaluate_gates`. (The generic no-op
// `decisionExecutor` is a placeholder for a future pure-routing decision step;
// no workflow uses one yet, so it is intentionally not registered here.)
// ---------------------------------------------------------------------------

export interface AssembleRunnerDeps {
  db: Db;
  // Read seam for `derive_pr_state` (production: the `gh`-CLI read transport).
  readTransport: GithubReadTransport;
  // Write seam for `github_api` (production: the `gh`-CLI write transport).
  writeTransport: GithubTransport;
  // Resolves a workflow id to its first step, for `fork` child spawning
  // (production: derived from the workflow registry).
  firstStepFactory: (workflowId: string) => Promise<FirstStepSpec>;
}

export function assembleRunner(deps: AssembleRunnerDeps): Runner {
  const runner = createRunner(deps.db);
  runner.register(StepType.ClaudeSkill, createClaudeSkillExecutor(deps.db));
  runner.register(StepType.Decision, evaluateGatesExecutor);
  runner.register(
    StepType.DerivePrState,
    createDerivePrStateExecutor({ db: deps.db, transport: deps.readTransport }),
  );
  runner.register(
    StepType.Fork,
    createForkExecutor(deps.db, { firstStepFactory: deps.firstStepFactory }),
  );
  runner.register(
    StepType.GithubApi,
    createGithubApiExecutor({ transport: deps.writeTransport }),
  );
  runner.register(StepType.WaitAuthorPush, createWaitAuthorPushExecutor());
  runner.register(StepType.WaitExternal, createWaitExternalExecutor(deps.db));
  return runner;
}
