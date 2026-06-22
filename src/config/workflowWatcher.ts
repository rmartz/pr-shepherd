import { watch as fsWatch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  ReloadStatus,
  type ReloadResult,
  type WorkflowRegistry,
} from "./workflowRegistry";

// ---------------------------------------------------------------------------
// Workflow hot-reload watcher (vision §5; issue #124).
//
// `startWorkflowWatcher` watches the `workflows/` directory and, on every
// change to a `*.yaml` file, re-loads just that file through the registry's
// `reloadFile`. A successful reload swaps the live definition so the next run
// enrolled picks it up; a rejected (invalid) reload keeps the prior good
// definition and surfaces the error. The watcher never throws into the daemon:
// a reload error is routed to `onError`, mirroring the discovery loop's
// `onTickError` fail-open contract.
//
// The underlying watcher is injectable (`watch`) so tests drive a simulated
// change event synchronously, without real filesystem timing. The default is
// Node's built-in `fs.watch` — `chokidar` is not a dependency and `fs.watch`
// on a directory suffices for the one event the registry cares about (a file
// changed), so no new package is introduced.
//
// `fs.watch` is known to emit duplicate events for a single save on some
// platforms. A short debounce coalesces a burst of events for the same file
// into one reload, so an editor's write-then-truncate save triggers exactly
// one reload attempt. The debounce timer is injectable for the same reason the
// loop's `sleep` is: tests fire the change and flush the timer deterministically.
// ---------------------------------------------------------------------------

const WORKFLOW_FILE_SUFFIX = ".yaml";
const DEFAULT_DEBOUNCE_MS = 100;

// The shape of the change listener `fs.watch` invokes: an event kind ("rename"
// | "change") and the basename of the affected file (which can be `undefined`
// on some platforms). We accept the broader Node signature so the built-in
// `fs.watch` is assignable to the injected seam without a cast.
export type WatchListener = (
  eventType: string,
  filename: string | undefined,
) => void;

// A minimal subset of `fs.FSWatcher` the watcher needs: a way to stop. Node's
// `FSWatcher` satisfies this, and a test fake implements just `close`.
export interface WatcherSubscription {
  close: () => void;
}

// The injected watch factory. Matches `fs.watch(dir, listener)` narrowed to
// the directory-watch overload the watcher uses.
export type WatchFactory = (
  dir: string,
  listener: WatchListener,
) => WatcherSubscription;

export interface WorkflowWatcherHandle {
  stop: () => void;
}

export interface StartWorkflowWatcherOptions {
  // Invoked after a successful reload with the registry's result. Lets the
  // daemon log "reloaded workflow <id>" without the watcher hard-coding a sink.
  onReload?: (result: ReloadResult) => void;
  // Invoked when a reload is rejected or the file is unreadable. The prior good
  // definition has already been retained by the registry at this point.
  onError?: (result: ReloadResult) => void;
  // Injectable watch factory; defaults to `fs.watch` on the directory.
  watch?: WatchFactory;
  // Debounce window coalescing duplicate events for one file; defaults to
  // 100ms. Injectable timer seams let tests flush synchronously.
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

function defaultWatch(
  dir: string,
  listener: WatchListener,
): WatcherSubscription {
  // `fs.watch`'s listener filename can be `string | null`; normalize null to
  // undefined to honor the repo's prefer-undefined convention before handing
  // it to the injected-seam-compatible listener.
  const watcher: FSWatcher = fsWatch(dir, (eventType, filename) => {
    listener(eventType, filename ?? undefined);
  });
  return watcher;
}

export function startWorkflowWatcher(
  registry: WorkflowRegistry,
  dir: string,
  options: StartWorkflowWatcherOptions = {},
): WorkflowWatcherHandle {
  const watch = options.watch ?? defaultWatch;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((timer) => {
      clearTimeout(timer);
    });

  // Per-file debounce timers, so a burst of events for one file collapses to a
  // single reload while events for *different* files stay independent.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const reload = (filename: string): void => {
    pending.delete(filename);
    const result = registry.reloadFile(join(dir, filename));
    if (result.status === ReloadStatus.Loaded) {
      options.onReload?.(result);
    } else {
      options.onError?.(result);
    }
  };

  const subscription = watch(dir, (_eventType, filename) => {
    if (filename?.endsWith(WORKFLOW_FILE_SUFFIX) !== true) {
      return;
    }
    const existing = pending.get(filename);
    if (existing !== undefined) {
      clearTimer(existing);
    }
    pending.set(
      filename,
      setTimer(() => {
        reload(filename);
      }, debounceMs),
    );
  });

  return {
    stop: () => {
      for (const timer of pending.values()) {
        clearTimer(timer);
      }
      pending.clear();
      subscription.close();
    },
  };
}
