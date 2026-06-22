import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadWorkflow, type WorkflowGraph } from "@/config";
import type { WorkflowResolver } from "@/engine/enrollment";

// ---------------------------------------------------------------------------
// Disk-backed workflow resolver (issue #207).
//
// The self-discovery / enrollment path needs a `WorkflowResolver`: a function
// that maps a matched `workflowId` to its loaded, validated `WorkflowGraph`.
// In production that mapping is the on-disk `workflows/<id>.yaml` set, read
// through the validated `loadWorkflow` loader (#122). This factory builds that
// resolver, caching each id's graph so a repeat resolve does not re-read and
// re-validate the file every self-discovery pass.
//
// A missing file resolves to `undefined` (the `WorkflowResolver` contract for
// an unknown id) rather than throwing, so a PR matched to a workflow with no
// definition is recorded as an `unresolved_workflow` skip instead of crashing
// the pass. A malformed-but-present definition still throws at load — that is a
// genuine misconfiguration the operator must fix.
// ---------------------------------------------------------------------------

// Repo-root-relative default, resolved from the process working directory so
// `shepherd start` reads the `workflows/` directory next to `config.yaml`.
const DEFAULT_WORKFLOWS_DIR = "workflows";

export function createDiskWorkflowResolver(
  workflowsDir: string = DEFAULT_WORKFLOWS_DIR,
): WorkflowResolver {
  const cache = new Map<string, WorkflowGraph | undefined>();

  return (workflowId) => {
    if (cache.has(workflowId)) return cache.get(workflowId);

    const path = resolve(workflowsDir, `${workflowId}.yaml`);
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // No definition on disk for this id — an unknown workflow, not an error.
      cache.set(workflowId, undefined);
      return undefined;
    }

    const graph = loadWorkflow(source);
    cache.set(workflowId, graph);
    return graph;
  };
}
