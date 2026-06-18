import { describe, expect, it } from "vitest";
import { loadWorkflow, WorkflowLoadError } from "./workflowLoader";
import { StepType } from "@/db/schemas";

// A minimal, valid workflow YAML covering two steps and a terminal route.
// Authored inline so each test controls exactly which property is malformed.
const VALID_WORKFLOW = `
id: base-pr
version: 1
steps:
  - id: review
    stepType: claude_skill
    input:
      skill: review
      pr: "{{ context.prNumber }}"
    routing:
      - condition: "output.verdict == 'approved'"
        next: wait_copilot_review
      - condition: "true"
        next: null
  - id: wait_copilot_review
    stepType: wait_external
    input:
      poller: copilot
    routing:
      - condition: "true"
        next: null
`;

describe("loadWorkflow parses a valid workflow into a typed step graph", () => {
  it("returns a WorkflowGraph with id, version, steps, and retained source", () => {
    const graph = loadWorkflow(VALID_WORKFLOW);

    expect(graph.id).toBe("base-pr");
    expect(graph.version).toBe(1);
    expect(graph.steps).toHaveLength(2);
    // The raw source is retained verbatim for the workflowDefinitions
    // reference-copy record.
    expect(graph.source).toBe(VALID_WORKFLOW);
  });

  it("maps each step to id, a known StepType, input template, and routing", () => {
    const graph = loadWorkflow(VALID_WORKFLOW);
    const review = graph.steps[0];

    expect(review?.id).toBe("review");
    expect(review?.stepType).toBe(StepType.ClaudeSkill);
    expect(review?.input).toEqual({
      skill: "review",
      pr: "{{ context.prNumber }}",
    });
    expect(review?.routing).toEqual([
      {
        condition: "output.verdict == 'approved'",
        next: "wait_copilot_review",
      },
      { condition: "true", next: undefined },
    ]);
  });
});

describe("loadWorkflow rejects an unknown stepType", () => {
  it("throws a WorkflowLoadError naming the workflow id and step id", () => {
    const yaml = `
id: base-pr
version: 1
steps:
  - id: bogus
    stepType: not_a_real_step
    input: {}
    routing:
      - condition: "true"
        next: null
`;

    expect(() => loadWorkflow(yaml)).toThrow(WorkflowLoadError);
    expect(() => loadWorkflow(yaml)).toThrow(/base-pr/);
    expect(() => loadWorkflow(yaml)).toThrow(/bogus/);
  });
});

describe("loadWorkflow rejects a dangling next reference", () => {
  it("throws a WorkflowLoadError identifying the workflow id and step id", () => {
    const yaml = `
id: base-pr
version: 1
steps:
  - id: review
    stepType: claude_skill
    input: {}
    routing:
      - condition: "true"
        next: does_not_exist
`;

    expect(() => loadWorkflow(yaml)).toThrow(WorkflowLoadError);
    expect(() => loadWorkflow(yaml)).toThrow(/review/);
    expect(() => loadWorkflow(yaml)).toThrow(/does_not_exist/);
  });
});

describe("loadWorkflow rejects an unknown routing identifier at load time", () => {
  it("throws a WorkflowLoadError surfacing the routing DSL parse failure", () => {
    const yaml = `
id: base-pr
version: 1
steps:
  - id: review
    stepType: claude_skill
    input: {}
    routing:
      - condition: "verdict == 'approved'"
        next: null
      - condition: "true"
        next: null
`;

    expect(() => loadWorkflow(yaml)).toThrow(WorkflowLoadError);
    expect(() => loadWorkflow(yaml)).toThrow(/review/);
    // The underlying parser message about the unknown identifier is preserved.
    expect(() => loadWorkflow(yaml)).toThrow(/verdict/);
  });
});

describe("loadWorkflow rejects duplicate step ids", () => {
  it("throws a WorkflowLoadError naming the workflow id and duplicate step id", () => {
    const yaml = `
id: base-pr
version: 1
steps:
  - id: review
    stepType: claude_skill
    input: {}
    routing:
      - condition: "true"
        next: null
  - id: review
    stepType: wait_external
    input: {}
    routing:
      - condition: "true"
        next: null
`;

    expect(() => loadWorkflow(yaml)).toThrow(WorkflowLoadError);
    expect(() => loadWorkflow(yaml)).toThrow(/base-pr/);
    expect(() => loadWorkflow(yaml)).toThrow(/review/);
  });
});
