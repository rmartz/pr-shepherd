import { describe, expect, it } from "vitest";
import {
  ReloadStatus,
  WorkflowRegistry,
  type ReloadResult,
} from "./workflowRegistry";
import {
  startWorkflowWatcher,
  type WatchListener,
  type WatcherSubscription,
} from "./workflowWatcher";

// ---------------------------------------------------------------------------
// Tests for the hot-reload watcher (issue #124). The underlying watcher and
// debounce timer are injected so a simulated change event drives a reload
// synchronously, with no real filesystem or timer dependence: a change event
// re-loads + updates the registry; an invalid change keeps the prior
// definition and reports the error.
// ---------------------------------------------------------------------------

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

const INVALID_WORKFLOW_YAML = `
id: base-pr
version: 9
steps:
  - id: review
    stepType: not_a_real_step_type
    input: {}
    routing:
      - condition: "true"
        next: null
`;

// A controllable `fs.watch` stand-in: captures the listener so the test can
// emit a change event on demand, and records whether `close` was called.
interface FakeWatcher {
  subscription: WatcherSubscription;
  emit: (filename: string | undefined) => void;
  closed: () => boolean;
}

function makeFakeWatch(): {
  watch: (dir: string, listener: WatchListener) => WatcherSubscription;
  watcher: FakeWatcher;
} {
  let captured: WatchListener | undefined;
  let isClosed = false;
  const subscription: WatcherSubscription = {
    close: () => {
      isClosed = true;
    },
  };
  return {
    watch: (_dir, listener) => {
      captured = listener;
      return subscription;
    },
    watcher: {
      subscription,
      emit: (filename) => captured?.("change", filename),
      closed: () => isClosed,
    },
  };
}

// A synchronous timer seam: fires the debounced callback immediately so the
// reload happens within the test's single tick, no real waiting.
function immediateTimer(fn: () => void): ReturnType<typeof setTimeout> {
  fn();
  return 0 as unknown as ReturnType<typeof setTimeout>;
}

describe("a change event re-loads and updates the registry", () => {
  it("reloads the changed file and surfaces the result to onReload", () => {
    const sources: Record<string, string> = {
      "workflows/base-pr.yaml": makeWorkflowYaml("base-pr", 1),
    };
    const registry = new WorkflowRegistry({
      readFile: (path) => sources[path] ?? "",
    });
    registry.reloadFile("workflows/base-pr.yaml");

    const { watch, watcher } = makeFakeWatch();
    const reloads: ReloadResult[] = [];
    const handle = startWorkflowWatcher(registry, "workflows", {
      watch,
      setTimer: immediateTimer,
      onReload: (result) => reloads.push(result),
    });

    // Operator edits the file, then the watcher fires a change event.
    sources["workflows/base-pr.yaml"] = makeWorkflowYaml("base-pr", 5);
    watcher.emit("base-pr.yaml");
    handle.stop();

    expect(reloads).toHaveLength(1);
    expect(reloads[0]?.status).toBe(ReloadStatus.Loaded);
    expect(registry.resolve("base-pr")?.version).toBe(5);
  });

  it("ignores change events for non-yaml files", () => {
    const registry = new WorkflowRegistry({ readFile: () => "" });
    const { watch, watcher } = makeFakeWatch();
    const reloads: ReloadResult[] = [];
    const handle = startWorkflowWatcher(registry, "workflows", {
      watch,
      setTimer: immediateTimer,
      onReload: (result) => reloads.push(result),
    });

    watcher.emit("notes.txt");
    handle.stop();

    expect(reloads).toHaveLength(0);
  });
});

describe("an invalid change keeps the prior definition and reports the error", () => {
  it("routes the rejected reload to onError and retains the prior version", () => {
    const sources: Record<string, string> = {
      "workflows/base-pr.yaml": makeWorkflowYaml("base-pr", 2),
    };
    const registry = new WorkflowRegistry({
      readFile: (path) => sources[path] ?? "",
    });
    registry.reloadFile("workflows/base-pr.yaml");

    const { watch, watcher } = makeFakeWatch();
    const errors: ReloadResult[] = [];
    const handle = startWorkflowWatcher(registry, "workflows", {
      watch,
      setTimer: immediateTimer,
      onError: (result) => errors.push(result),
    });

    // Operator saves a broken edit; the change event fires.
    sources["workflows/base-pr.yaml"] = INVALID_WORKFLOW_YAML;
    watcher.emit("base-pr.yaml");
    handle.stop();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.status).toBe(ReloadStatus.Rejected);
    expect(errors[0]?.retainedPrevious).toBe(true);
    // The last-good version 2 is still served despite the bad edit.
    expect(registry.resolve("base-pr")?.version).toBe(2);
  });
});

describe("stop closes the underlying watcher", () => {
  it("closes the subscription so no further events are processed", () => {
    const registry = new WorkflowRegistry({ readFile: () => "" });
    const { watch, watcher } = makeFakeWatch();
    const handle = startWorkflowWatcher(registry, "workflows", {
      watch,
      setTimer: immediateTimer,
    });

    expect(watcher.closed()).toBe(false);
    handle.stop();
    expect(watcher.closed()).toBe(true);
  });
});
