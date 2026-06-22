import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createDiskWorkflowResolver } from "./resolveWorkflow";

// ---------------------------------------------------------------------------
// Tests for `createDiskWorkflowResolver` — the production `WorkflowResolver`
// the bootstrap wires into self-discovery. It reads `workflows/<id>.yaml` and
// loads each through the validated workflow loader, caching the result per id.
// ---------------------------------------------------------------------------

const WORKFLOWS_DIR = resolve(__dirname, "../../../workflows");

describe("resolves a configured workflow id to its on-disk graph", () => {
  it("loads the base-pr definition from workflows/base-pr.yaml", () => {
    const resolveWorkflow = createDiskWorkflowResolver(WORKFLOWS_DIR);

    const graph = resolveWorkflow("base-pr");

    expect(graph?.id).toBe("base-pr");
    expect(graph?.steps.length).toBeGreaterThan(0);
  });

  it("returns undefined for an id with no on-disk definition", () => {
    const resolveWorkflow = createDiskWorkflowResolver(WORKFLOWS_DIR);

    expect(resolveWorkflow("no-such-workflow")).toBeUndefined();
  });

  it("returns the same cached graph instance on a repeat resolve", () => {
    const resolveWorkflow = createDiskWorkflowResolver(WORKFLOWS_DIR);

    const first = resolveWorkflow("base-pr");
    const second = resolveWorkflow("base-pr");

    expect(second).toBe(first);
  });
});
