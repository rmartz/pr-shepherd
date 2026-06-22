---
type: Subsystem
title: Workflow Hot-Reload
description: An in-memory registry of loaded workflow graphs that a file watcher refreshes when a workflows/*.yaml changes, so an operator edits a workflow without restarting the daemon.
resource: src/config/workflowRegistry.ts
tags: [workflow, config, hot-reload, registry, watcher, resilience]
---

# Workflow Hot-Reload

The daemon keeps every workflow definition in an in-memory **registry** so a run
can be enrolled without re-reading the YAML each time. A **watcher** keeps that
registry honest: when an operator edits a `workflows/*.yaml`, the changed file is
re-loaded through the [#122 workflow loader](../../src/config/workflowLoader.ts)
and swapped into the registry — no daemon restart required.

```
fs.watch(workflows/) → change event → registry.reloadFile → loadWorkflow → swap live graph
```

## Registry — `WorkflowRegistry`

`src/config/workflowRegistry.ts` holds a `Map<workflowId, WorkflowGraph>`.

- `resolve(workflowId)` returns the currently-live graph, matching enrollment's
  [`WorkflowResolver`](../../src/engine/enrollment/enrollDiscovered.ts) seam, so
  the registry is passed straight through as `(id) => registry.resolve(id)`.
- `reloadFile(filePath)` re-reads one file, validates it via `loadWorkflow`, and
  swaps the definition. It **never throws**: a read or validation failure returns
  a `ReloadResult` with status `Rejected` / `Unreadable` and the prior good
  definition left in place.
- `loadWorkflowRegistry(dir)` builds the registry from a directory fail-open — a
  single malformed file is collected in `errors[]` rather than aborting startup.

All filesystem access (`readFile`, `listDir`) is injected, so tests drive a
reload from in-memory sources with no real disk or timer dependence.

## Watcher — `startWorkflowWatcher`

`src/config/workflowWatcher.ts` wraps `fs.watch` on the `workflows/` directory
(no `chokidar` dependency — the built-in suffices for "a file changed"). It
mirrors the discovery loop's fail-open contract: a successful reload goes to
`onReload`, a rejected one to `onError`, and the daemon is never crashed by a bad
edit. A short, injectable **debounce** coalesces the duplicate events `fs.watch`
emits for a single save into one reload attempt. `stop()` clears pending timers
and closes the underlying watcher.

## Last-good retention

A reload that fails validation is **rejected, not applied** (vision §5): the
error is surfaced and the previously-loaded definition is retained. A bad edit
therefore can never evict a good workflow or take the daemon down.

## In-flight runs are unaffected

A reload only changes what a **newly-enrolled** run resolves. Runs already
in-flight pinned their `workflowVersion` (and a verbatim `source` copy in
`workflowDefinitions`) at enrollment time — see
[run enrollment](../../src/engine/enrollment/enroll.ts) — so a later reload never
mutates a run already in progress. New runs pick up the reloaded graph; old runs
finish on the version they started.

## Related

- [workflow loader](../../src/config/workflowLoader.ts) — the #122 parse +
  layered validation the registry reuses on every reload.
- [Self-Discovery](self-discovery.md) — consumes the resolver the registry backs.
- [base-pr](../workflows/base-pr.md) — a workflow definition the registry serves.
