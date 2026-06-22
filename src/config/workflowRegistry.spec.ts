import { describe, expect, it } from "vitest";
import type { WorkflowResolver } from "@/engine/enrollment";
import {
  loadWorkflowRegistry,
  ReloadStatus,
  WorkflowRegistry,
} from "./workflowRegistry";

// ---------------------------------------------------------------------------
// Tests for the in-memory workflow registry (issue #124). All filesystem
// access is injected so a reload is driven from in-memory sources — a
// successful reload swaps the live definition, while a rejected (invalid)
// reload retains the prior good definition and reports the error.
// ---------------------------------------------------------------------------

// A minimal, valid workflow YAML for `id`/`version`, authored via a generator
// so each test controls the two fields the registry keys on.
function makeWorkflowYaml(id: string, version: number): string {
  return `
id: ${id}
version: ${String(version)}
steps:
  - id: review
    stepType: claude_skill
    input:
      skill: review
    routing:
      - condition: "true"
        next: null
`;
}

// A source that is structurally invalid (unknown stepType) so `loadWorkflow`
// rejects it — the registry must keep the prior good definition.
const INVALID_WORKFLOW_YAML = `
id: base-pr
version: 2
steps:
  - id: review
    stepType: not_a_real_step_type
    input: {}
    routing:
      - condition: "true"
        next: null
`;

// Builds a `readFile` seam from a path→source map, throwing ENOENT-style for an
// unmapped path so the "unreadable" branch can be exercised explicitly.
function makeReadFile(
  sources: Record<string, string>,
): (path: string) => string {
  return (path) => {
    const source = sources[path];
    if (source === undefined) {
      throw new Error(`ENOENT: no such file '${path}'`);
    }
    return source;
  };
}

describe("a change event re-loads the workflow and updates the registry", () => {
  it("registers the newly-loaded definition under its id", () => {
    const registry = new WorkflowRegistry({
      readFile: makeReadFile({
        "workflows/base-pr.yaml": makeWorkflowYaml("base-pr", 1),
      }),
    });

    const result = registry.reloadFile("workflows/base-pr.yaml");

    expect(result.status).toBe(ReloadStatus.Loaded);
    expect(result.workflowId).toBe("base-pr");
    expect(registry.resolve("base-pr")?.version).toBe(1);
  });

  it("swaps the live definition so a later resolve returns the new version", () => {
    const sources: Record<string, string> = {
      "workflows/base-pr.yaml": makeWorkflowYaml("base-pr", 1),
    };
    const registry = new WorkflowRegistry({ readFile: makeReadFile(sources) });
    registry.reloadFile("workflows/base-pr.yaml");

    // Operator edits the file: the seam now returns version 7.
    sources["workflows/base-pr.yaml"] = makeWorkflowYaml("base-pr", 7);
    const result = registry.reloadFile("workflows/base-pr.yaml");

    expect(result.status).toBe(ReloadStatus.Loaded);
    expect(registry.resolve("base-pr")?.version).toBe(7);
  });
});

describe("a rejected reload retains the prior good definition", () => {
  it("keeps the previous version and reports the validation error", () => {
    const sources: Record<string, string> = {
      "workflows/base-pr.yaml": makeWorkflowYaml("base-pr", 3),
    };
    const registry = new WorkflowRegistry({ readFile: makeReadFile(sources) });
    registry.reloadFile("workflows/base-pr.yaml");

    // Operator saves a broken edit.
    sources["workflows/base-pr.yaml"] = INVALID_WORKFLOW_YAML;
    const result = registry.reloadFile("workflows/base-pr.yaml");

    expect(result.status).toBe(ReloadStatus.Rejected);
    expect(result.retainedPrevious).toBe(true);
    expect(result.error).toBeDefined();
    // The last-good version 3 is still served; the bad edit never evicted it.
    expect(registry.resolve("base-pr")?.version).toBe(3);
  });

  it("reports an unreadable file without evicting the prior definition", () => {
    const sources: Record<string, string> = {
      "workflows/base-pr.yaml": makeWorkflowYaml("base-pr", 4),
    };
    const registry = new WorkflowRegistry({ readFile: makeReadFile(sources) });
    registry.reloadFile("workflows/base-pr.yaml");

    // File removed mid-event: the seam now throws for this path.
    delete sources["workflows/base-pr.yaml"];
    const result = registry.reloadFile("workflows/base-pr.yaml");

    expect(result.status).toBe(ReloadStatus.Unreadable);
    expect(registry.resolve("base-pr")?.version).toBe(4);
  });
});

describe("the registry backs enrollment's WorkflowResolver seam", () => {
  it("resolves the post-reload version, so only new runs see the new graph", () => {
    const sources: Record<string, string> = {
      "workflows/base-pr.yaml": makeWorkflowYaml("base-pr", 1),
    };
    const registry = new WorkflowRegistry({ readFile: makeReadFile(sources) });
    registry.reloadFile("workflows/base-pr.yaml");

    // Used exactly as enrollDiscovered consumes it: a WorkflowResolver.
    const resolve: WorkflowResolver = (id) => registry.resolve(id);
    expect(resolve("base-pr")?.version).toBe(1);

    // A hot edit + reload changes what a *subsequent* resolve returns; runs
    // already enrolled pinned version 1 at enroll time and are untouched.
    sources["workflows/base-pr.yaml"] = makeWorkflowYaml("base-pr", 2);
    registry.reloadFile("workflows/base-pr.yaml");
    expect(resolve("base-pr")?.version).toBe(2);
  });
});

describe("loadWorkflowRegistry loads every yaml in a directory fail-open", () => {
  it("registers valid workflows and collects per-file errors for invalid ones", () => {
    const { registry, errors } = loadWorkflowRegistry("workflows", {
      listDir: () => ["base-pr.yaml", "broken.yaml", "README.md"],
      readFile: makeReadFile({
        "workflows/base-pr.yaml": makeWorkflowYaml("base-pr", 1),
        "workflows/broken.yaml": INVALID_WORKFLOW_YAML,
      }),
    });

    // The valid workflow is live; the malformed one did not abort the load.
    expect(registry.resolve("base-pr")?.version).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.status).toBe(ReloadStatus.Rejected);
    // The non-yaml entry was ignored entirely (not read, not an error).
    expect(registry.all()).toHaveLength(1);
  });
});
