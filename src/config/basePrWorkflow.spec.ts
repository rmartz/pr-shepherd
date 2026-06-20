import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflow, type WorkflowStep } from "./workflowLoader";
import { StepType } from "@/db/schemas";
import { Action } from "@/engine/gates";

// ---------------------------------------------------------------------------
// Definition test for `workflows/base-pr.yaml` (issue #102).
//
// This exercises the *real* workflow definition through the #122 loader: it
// must load cleanly (acceptance criterion 4) and its `evaluate_gates` step's
// routing must map each gate `Action` to the right concrete next step. The
// representative routings the issue calls out — approved→merge,
// changes_requested→fix, ci_failing→fix, blocked→park — are all decided by the
// `output.action` the `evaluate_gates` step emits, so asserting the action→step
// routing covers them directly.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(here, "..", "..", "workflows", "base-pr.yaml");
const source = readFileSync(WORKFLOW_PATH, "utf8");

function stepById(steps: WorkflowStep[], id: string): WorkflowStep {
  const step = steps.find((s) => s.id === id);
  if (step === undefined) {
    throw new Error(`base-pr workflow has no step "${id}"`);
  }
  return step;
}

// The concrete step a routing branch lands on for a given gate action, read off
// the `evaluate_gates` step's `output.action == '<action>'` rule.
function routeForAction(gatesStep: WorkflowStep, action: Action): string {
  const rule = gatesStep.routing.find(
    (r) => r.condition === `output.action == '${action}'`,
  );
  if (rule === undefined) {
    throw new Error(
      `evaluate_gates has no routing rule for action "${action}"`,
    );
  }
  if (rule.next === undefined) {
    throw new Error(`evaluate_gates routes action "${action}" to a terminal`);
  }
  return rule.next;
}

describe("base-pr workflow loads cleanly through the workflow loader", () => {
  it("parses into a typed step graph with the expected id", () => {
    const graph = loadWorkflow(source);

    expect(graph.id).toBe("base-pr");
    expect(graph.version).toBe(1);
  });

  it("defines every step the lifecycle requires", () => {
    const graph = loadWorkflow(source);
    const ids = graph.steps.map((step) => step.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "derive_pr_state",
        "evaluate_gates",
        "review",
        "post_review",
        "fix_review",
        "post_fix_review_acks",
        "wait_ci",
        "wait_copilot_review",
        "wait_author_push",
        "merge",
        "post_merge",
      ]),
    );
  });
});

describe("base-pr begins each tick by re-deriving PR state", () => {
  it("makes derive_pr_state the first step and routes it into evaluate_gates", () => {
    const graph = loadWorkflow(source);
    const derive = graph.steps[0];

    expect(derive?.id).toBe("derive_pr_state");
    expect(derive?.stepType).toBe(StepType.DerivePrState);
    expect(derive?.routing.map((rule) => rule.next)).toContain(
      "evaluate_gates",
    );
  });

  it("dispatches evaluate_gates as a decision-type step", () => {
    const graph = loadWorkflow(source);
    const gates = stepById(graph.steps, "evaluate_gates");

    expect(gates.stepType).toBe(StepType.Decision);
  });
});

describe("evaluate_gates routes each gate action to its concrete step", () => {
  it("routes an approved PR (action=merge) to the merge step", () => {
    const graph = loadWorkflow(source);
    const gates = stepById(graph.steps, "evaluate_gates");

    expect(routeForAction(gates, Action.Merge)).toBe("merge");
  });

  it("routes a changes-requested PR (action=review) to the review step", () => {
    const graph = loadWorkflow(source);
    const gates = stepById(graph.steps, "evaluate_gates");

    expect(routeForAction(gates, Action.Review)).toBe("review");
  });

  it("routes a CI-failing reviewed PR (action=fix_review) to the fix_review step", () => {
    const graph = loadWorkflow(source);
    const gates = stepById(graph.steps, "evaluate_gates");

    expect(routeForAction(gates, Action.FixReview)).toBe("fix_review");
  });

  it("routes a blocked/held PR (action=park) to a terminal park branch", () => {
    const graph = loadWorkflow(source);
    const gates = stepById(graph.steps, "evaluate_gates");
    const rule = gates.routing.find(
      (r) => r.condition === `output.action == '${Action.Park}'`,
    );

    expect(rule).toBeDefined();
    // Parking ends the run for this tick rather than re-deriving immediately;
    // it auto-resumes on the next scheduled cycle when its cause clears.
    expect(rule?.next).toBeUndefined();
  });

  it("routes a CI-running PR (action=wait_ci) to the wait_ci step", () => {
    const graph = loadWorkflow(source);
    const gates = stepById(graph.steps, "evaluate_gates");

    expect(routeForAction(gates, Action.WaitCi)).toBe("wait_ci");
  });

  it("routes a copilot-pending PR (action=wait_copilot) to the wait_copilot_review step", () => {
    const graph = loadWorkflow(source);
    const gates = stepById(graph.steps, "evaluate_gates");

    expect(routeForAction(gates, Action.WaitCopilot)).toBe(
      "wait_copilot_review",
    );
  });

  it("routes a remote-wait PR (action=wait_remote) to the wait_author_push step", () => {
    const graph = loadWorkflow(source);
    const gates = stepById(graph.steps, "evaluate_gates");

    expect(routeForAction(gates, Action.WaitRemote)).toBe("wait_author_push");
  });

  it("handles every gate Action so no derived action falls through", () => {
    const graph = loadWorkflow(source);
    const gates = stepById(graph.steps, "evaluate_gates");
    const handled = new Set(gates.routing.map((rule) => rule.condition));

    for (const action of Object.values(Action)) {
      expect(handled.has(`output.action == '${action}'`)).toBe(true);
    }
    // …plus the DSL-required catch-all.
    expect(handled.has("true")).toBe(true);
  });
});

describe("base-pr re-derives after each mutating or wait step", () => {
  it("routes every effectful step back to derive_pr_state", () => {
    const graph = loadWorkflow(source);
    const effectfulSteps = [
      "post_review",
      "post_fix_review_acks",
      "post_merge",
      "wait_ci",
      "wait_copilot_review",
      "wait_author_push",
    ];

    for (const id of effectfulSteps) {
      const step = stepById(graph.steps, id);
      const targets = step.routing.map((rule) => rule.next);
      expect(targets).toContain("derive_pr_state");
    }
  });
});

describe("base-pr CI mutation steps dispatch the correct github_api action type", () => {
  it("authorize_ci step dispatches type: authorize_ci", () => {
    const graph = loadWorkflow(source);
    const step = stepById(graph.steps, "authorize_ci");
    const actions = step.input["actions"] as { type: string }[];

    expect(actions[0]?.type).toBe("authorize_ci");
  });

  it("rerun_ci step dispatches type: rerun_ci (not authorize_ci)", () => {
    const graph = loadWorkflow(source);
    const step = stepById(graph.steps, "rerun_ci");
    const actions = step.input["actions"] as { type: string }[];

    expect(actions[0]?.type).toBe("rerun_ci");
  });
});

describe("base-pr isolates GitHub mutation behind github_api steps", () => {
  it("pairs each claude_skill step with a downstream github_api step", () => {
    const graph = loadWorkflow(source);

    // The Claude skills (review/fix_review/merge) must never mutate GitHub
    // directly: each routes only to its paired github_api poster.
    const pairs: Record<string, string> = {
      review: "post_review",
      fix_review: "post_fix_review_acks",
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

  it("uses no github_api step type for any claude_skill-named action", () => {
    const graph = loadWorkflow(source);
    const skillIds = new Set(["review", "fix_review", "merge"]);

    for (const step of graph.steps) {
      if (skillIds.has(step.id)) {
        expect(step.stepType).toBe(StepType.ClaudeSkill);
      }
    }
  });
});
