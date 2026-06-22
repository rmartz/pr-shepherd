import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflow, type WorkflowStep } from "./workflowLoader";
import { StepType } from "@/db/schemas";
import { Action } from "@/engine/gates";

// ---------------------------------------------------------------------------
// Definition tests for the Dependabot workflows (issue #103).
//
// Both `workflows/dependabot-pr.yaml` and `workflows/dependabot-fix.yaml` are
// exercised through the *real* #122 loader: each must load cleanly and wire its
// steps the way the lifecycle requires. The `dependabot-pr` workflow classifies
// a Dependabot PR off the same `derive_pr_state` + `evaluate_gates` decision the
// base-pr workflow uses, but routes the gate `Action`s onto the three
// Dependabot-specific branches the issue calls out:
//
//   - mergeable    → review → merge        (action=merge / action=review)
//   - ci-failing & fixable → spawn_fix_pr (fork) → wait_fix_pr →
//       rebase_dependabot → wait_ci → re-derive   (action=fix_review, CI-driven)
//   - conflicting  → rebase_dependabot     (action=fix_review, conflict-driven)
//   - ci-failing & not-fixable → terminal fail (action=park → terminal)
//
// The conflict-driven and CI-driven fix branches are both `action=fix_review`;
// they are disambiguated by `output.blockingGate` (`no_conflict` vs `ci_green`)
// so a conflicting branch rebases while a CI failure spawns a fix child.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(here, "..", "..", "workflows");
const PR_SOURCE = readFileSync(
  join(WORKFLOWS_DIR, "dependabot-pr.yaml"),
  "utf8",
);
const FIX_SOURCE = readFileSync(
  join(WORKFLOWS_DIR, "dependabot-fix.yaml"),
  "utf8",
);

function stepById(steps: WorkflowStep[], id: string): WorkflowStep {
  const step = steps.find((s) => s.id === id);
  if (step === undefined) {
    throw new Error(`workflow has no step "${id}"`);
  }
  return step;
}

// The concrete step a routing branch lands on for an exact condition string.
function routeForCondition(step: WorkflowStep, condition: string): string {
  const rule = step.routing.find((r) => r.condition === condition);
  if (rule === undefined) {
    throw new Error(`step "${step.id}" has no routing rule "${condition}"`);
  }
  if (rule.next === undefined) {
    throw new Error(`rule "${condition}" routes to a terminal`);
  }
  return rule.next;
}

describe("dependabot-pr workflow loads cleanly through the workflow loader", () => {
  it("parses into a typed step graph with the expected id", () => {
    const graph = loadWorkflow(PR_SOURCE);

    expect(graph.id).toBe("dependabot-pr");
    expect(graph.version).toBe(1);
  });

  it("re-derives state at the head of every tick", () => {
    const graph = loadWorkflow(PR_SOURCE);
    const derive = graph.steps[0];

    expect(derive?.id).toBe("derive_pr_state");
    expect(derive?.stepType).toBe(StepType.DerivePrState);
    expect(derive?.routing.map((rule) => rule.next)).toContain(
      "evaluate_gates",
    );
  });

  it("classifies via a decision-type evaluate_gates step", () => {
    const graph = loadWorkflow(PR_SOURCE);
    const gates = stepById(graph.steps, "evaluate_gates");

    expect(gates.stepType).toBe(StepType.Decision);
  });
});

describe("dependabot-pr classification branch: mergeable → review → merge", () => {
  it("routes an approved PR (action=merge) to the merge step", () => {
    const graph = loadWorkflow(PR_SOURCE);
    const gates = stepById(graph.steps, "evaluate_gates");

    expect(routeForCondition(gates, `output.action == '${Action.Merge}'`)).toBe(
      "merge",
    );
  });

  it("routes a review-needed PR (action=review) to the review step", () => {
    const graph = loadWorkflow(PR_SOURCE);
    const gates = stepById(graph.steps, "evaluate_gates");

    expect(
      routeForCondition(gates, `output.action == '${Action.Review}'`),
    ).toBe("review");
  });

  it("pairs the merge skill with its github_api poster", () => {
    const graph = loadWorkflow(PR_SOURCE);
    const merge = stepById(graph.steps, "merge");
    const poster = stepById(graph.steps, "post_merge");

    expect(merge.stepType).toBe(StepType.ClaudeSkill);
    expect(poster.stepType).toBe(StepType.GithubApi);
    expect(merge.routing.map((rule) => rule.next)).toContain("post_merge");
  });
});

describe("dependabot-pr classification branch: ci-failing & fixable → spawn fix PR", () => {
  it("routes a CI-driven fix_review (blockingGate=ci_green) to spawn_fix_pr", () => {
    const graph = loadWorkflow(PR_SOURCE);
    const gates = stepById(graph.steps, "evaluate_gates");

    expect(
      routeForCondition(
        gates,
        `output.action == '${Action.FixReview}' && output.blockingGate == 'ci_green'`,
      ),
    ).toBe("spawn_fix_pr");
  });

  it("spawns the fix child as a fork into the dependabot-fix workflow", () => {
    const graph = loadWorkflow(PR_SOURCE);
    const fork = stepById(graph.steps, "spawn_fix_pr");

    expect(fork.stepType).toBe(StepType.Fork);
    expect(fork.input["workflowId"]).toBe("dependabot-fix");
  });

  it("waits on the fix PR via a wait_external fix_pr step after forking", () => {
    const graph = loadWorkflow(PR_SOURCE);
    const fork = stepById(graph.steps, "spawn_fix_pr");
    const wait = stepById(graph.steps, "wait_fix_pr");

    expect(fork.routing.map((rule) => rule.next)).toContain("wait_fix_pr");
    expect(wait.stepType).toBe(StepType.WaitExternal);
    expect(wait.input["kind"]).toBe("fix_pr");
  });

  it("rebases then waits on CI and re-derives after the fix lands", () => {
    const graph = loadWorkflow(PR_SOURCE);
    const wait = stepById(graph.steps, "wait_fix_pr");
    const rebase = stepById(graph.steps, "rebase_dependabot");
    const waitCi = stepById(graph.steps, "wait_ci");

    expect(wait.routing.map((rule) => rule.next)).toContain(
      "rebase_dependabot",
    );
    expect(rebase.routing.map((rule) => rule.next)).toContain("wait_ci");
    expect(waitCi.routing.map((rule) => rule.next)).toContain(
      "derive_pr_state",
    );
  });
});

describe("dependabot-pr classification branch: conflicting → rebase", () => {
  it("routes a conflict-driven fix_review (blockingGate=no_conflict) to rebase_dependabot", () => {
    const graph = loadWorkflow(PR_SOURCE);
    const gates = stepById(graph.steps, "evaluate_gates");

    expect(
      routeForCondition(
        gates,
        `output.action == '${Action.FixReview}' && output.blockingGate == 'no_conflict'`,
      ),
    ).toBe("rebase_dependabot");
  });
});

describe("dependabot-pr classification branch: ci-failing & not-fixable → terminal fail", () => {
  it("routes a held/not-fixable PR (action=park) to a terminal branch", () => {
    const graph = loadWorkflow(PR_SOURCE);
    const gates = stepById(graph.steps, "evaluate_gates");
    const rule = gates.routing.find(
      (r) => r.condition === `output.action == '${Action.Park}'`,
    );

    expect(rule).toBeDefined();
    expect(rule?.next).toBeUndefined();
  });
});

describe("dependabot-pr rebase_dependabot consumes the derived rebase marker", () => {
  it("dispatches a rebase_dependabot github_api action guarded by the marker", () => {
    const graph = loadWorkflow(PR_SOURCE);
    const rebase = stepById(graph.steps, "rebase_dependabot");
    const actions = rebase.input["actions"] as {
      type: string;
      params: { rebaseInProgress: unknown };
    }[];

    expect(rebase.stepType).toBe(StepType.GithubApi);
    expect(actions[0]?.type).toBe("rebase_dependabot");
    // The guard rides on the action: the executor no-ops when a rebase is
    // already running, so this must carry the derived in-progress marker rather
    // than a hardcoded false.
    expect(actions[0]?.params.rebaseInProgress).toBe(
      "{{ context.state.dependabotRebase == 'in_progress' }}",
    );
  });
});

describe("dependabot-pr handles every gate Action so none falls through", () => {
  it("covers every Action plus the DSL catch-all", () => {
    const graph = loadWorkflow(PR_SOURCE);
    const gates = stepById(graph.steps, "evaluate_gates");
    const handled = gates.routing.map((rule) => rule.condition);

    for (const action of Object.values(Action)) {
      const hit = handled.some((c) =>
        c.includes(`output.action == '${action}'`),
      );
      expect(hit).toBe(true);
    }
    expect(handled).toContain("true");
  });
});

describe("dependabot-fix child workflow: implement-fix → review → merge", () => {
  it("parses into a typed step graph with the expected id", () => {
    const graph = loadWorkflow(FIX_SOURCE);

    expect(graph.id).toBe("dependabot-fix");
    expect(graph.version).toBe(1);
  });

  it("starts with an implement-fix claude_skill step", () => {
    const graph = loadWorkflow(FIX_SOURCE);
    const first = graph.steps[0];

    expect(first?.id).toBe("implement_fix");
    expect(first?.stepType).toBe(StepType.ClaudeSkill);
  });

  it("flows implement-fix → review → merge", () => {
    const graph = loadWorkflow(FIX_SOURCE);
    const implement = stepById(graph.steps, "implement_fix");
    const review = stepById(graph.steps, "review");
    const merge = stepById(graph.steps, "merge");

    expect(implement.routing.map((rule) => rule.next)).toContain("review");
    expect(review.stepType).toBe(StepType.ClaudeSkill);
    expect(merge.stepType).toBe(StepType.ClaudeSkill);
  });

  it("isolates every claude_skill behind a paired github_api poster", () => {
    const graph = loadWorkflow(FIX_SOURCE);
    const pairs: Record<string, string> = {
      review: "post_review",
      merge: "post_merge",
    };

    for (const [skillId, posterId] of Object.entries(pairs)) {
      const skill = stepById(graph.steps, skillId);
      const poster = stepById(graph.steps, posterId);
      expect(skill.stepType).toBe(StepType.ClaudeSkill);
      expect(poster.stepType).toBe(StepType.GithubApi);
      expect(skill.routing.map((rule) => rule.next)).toContain(posterId);
    }
  });
});
