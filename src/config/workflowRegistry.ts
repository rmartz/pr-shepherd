import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadWorkflow,
  WorkflowLoadError,
  type WorkflowGraph,
} from "./workflowLoader";

// ---------------------------------------------------------------------------
// In-memory workflow registry (vision §5; issue #124).
//
// The registry is the daemon's authoritative, hot-reloadable map of
// `workflowId → loaded WorkflowGraph`. `enrollDiscovered`'s `WorkflowResolver`
// seam reads it via `resolve`, so a *newly-started* run picks up whatever
// definition the registry currently holds. In-flight runs are unaffected:
// each run pins its `workflowVersion` (and a source copy) at enrollment time,
// so a later reload never mutates a run already in progress.
//
// Reloads go through the #122 `loadWorkflow`, so the same layered validation
// (schema → cross-step routing → DSL conditions) guards a hot edit that a
// startup load enforces. A reload that fails validation is *rejected*: the
// error is surfaced and the previously-loaded definition is retained, so a bad
// edit can never evict a good workflow or take down the daemon.
//
// All filesystem access is funneled through injectable seams (`readFile`,
// `listDir`) so tests can drive a reload from in-memory sources without
// touching the disk or relying on real filesystem timing.
// ---------------------------------------------------------------------------

const WORKFLOW_FILE_SUFFIX = ".yaml";

// Reasons a `reloadFile` call left the registry unchanged or partially
// applied. `Loaded` is the success case; the rest each retain the prior good
// definition (if any).
export enum ReloadStatus {
  // The file parsed and validated; its definition is now live in the registry.
  Loaded = "loaded",
  // The file failed `loadWorkflow` validation; the prior definition is kept.
  Rejected = "rejected",
  // The file could not be read (e.g. removed mid-event); prior definition kept.
  Unreadable = "unreadable",
}

export interface ReloadResult {
  status: ReloadStatus;
  filePath: string;
  // Set on `Loaded`: the id of the workflow now registered.
  workflowId?: string;
  // Set on `Rejected` / `Unreadable`: the error that caused the rejection.
  error?: Error;
  // `true` when a prior definition for this file's workflow was retained
  // because the reload was rejected. Lets the caller log "kept previous good".
  retainedPrevious?: boolean;
}

export interface WorkflowRegistryOptions {
  // Injectable file reader; defaults to a UTF-8 `readFileSync`.
  readFile?: (filePath: string) => string;
  // Injectable directory lister returning the entry names in `dir`; defaults
  // to `readdirSync`.
  listDir?: (dir: string) => string[];
}

export class WorkflowRegistry {
  // workflowId → loaded graph. The map is the single source of truth a run
  // enrollment reads through `resolve`.
  private readonly byId = new Map<string, WorkflowGraph>();
  // filePath → the workflowId that file last contributed. Lets a reload of a
  // file whose id changed evict the stale id, and lets a rejected reload know
  // which prior definition it is protecting.
  private readonly idByFile = new Map<string, string>();
  private readonly readFile: (filePath: string) => string;

  constructor(options: WorkflowRegistryOptions = {}) {
    this.readFile =
      options.readFile ?? ((filePath) => readFileSync(filePath, "utf8"));
  }

  // Resolve a workflow id to its currently-loaded graph, or `undefined` when
  // no definition is registered. Matches `enrollDiscovered`'s
  // `WorkflowResolver` signature so the registry can be passed directly.
  resolve(workflowId: string): WorkflowGraph | undefined {
    return this.byId.get(workflowId);
  }

  // Every currently-registered graph, for diagnostics / listing.
  all(): WorkflowGraph[] {
    return [...this.byId.values()];
  }

  // (Re)load a single workflow file and update the registry. On success the
  // file's definition replaces any prior one for its id. On any failure the
  // prior definition is retained and the error is returned rather than thrown,
  // so a watcher callback never propagates a bad edit into a daemon crash.
  reloadFile(filePath: string): ReloadResult {
    let source: string;
    try {
      source = this.readFile(filePath);
    } catch (cause) {
      return this.failure(filePath, ReloadStatus.Unreadable, cause);
    }

    let graph: WorkflowGraph;
    try {
      graph = loadWorkflow(source);
    } catch (cause) {
      return this.failure(filePath, ReloadStatus.Rejected, cause);
    }

    const previousId = this.idByFile.get(filePath);
    if (previousId !== undefined && previousId !== graph.id) {
      this.byId.delete(previousId);
    }
    this.byId.set(graph.id, graph);
    this.idByFile.set(filePath, graph.id);
    return { status: ReloadStatus.Loaded, filePath, workflowId: graph.id };
  }

  private failure(
    filePath: string,
    status: ReloadStatus,
    cause: unknown,
  ): ReloadResult {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    return {
      status,
      filePath,
      error,
      retainedPrevious: this.idByFile.has(filePath),
    };
  }
}

// Load every `*.yaml` under `dir` into a fresh registry. A file that fails
// validation is skipped (its error collected in `errors`) rather than aborting
// the whole load, so one malformed workflow does not prevent the daemon from
// starting with the rest. Mirrors `loadWorkflow`'s fail-fast-per-defect intent
// while keeping the directory load fail-open across files.
export interface RegistryLoadResult {
  registry: WorkflowRegistry;
  errors: ReloadResult[];
}

export function loadWorkflowRegistry(
  dir: string,
  options: WorkflowRegistryOptions = {},
): RegistryLoadResult {
  const listDir = options.listDir ?? ((target) => readdirSync(target));
  const registry = new WorkflowRegistry(options);
  const errors: ReloadResult[] = [];

  for (const entry of listDir(dir)) {
    if (!entry.endsWith(WORKFLOW_FILE_SUFFIX)) continue;
    const result = registry.reloadFile(join(dir, entry));
    if (result.status !== ReloadStatus.Loaded) {
      errors.push(result);
    }
  }

  return { registry, errors };
}

export { WorkflowLoadError };
