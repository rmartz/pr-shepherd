---
type: Subsystem
title: Commands Listener
description: The daemon-side consumer of the operator → daemon control plane — applies UI-issued pause / resume / force-retry commands to runs and steps.
resource: src/engine/commands
tags: [control-plane, commands, operator, idempotency]
---

# Commands Listener

The commands listener is the daemon side of PR Shepherd's **operator → daemon control plane** (see [ARCHITECTURE.md](../../ARCHITECTURE.md) "Operator → daemon control plane"). The daemon exposes no HTTP surface, so operator actions from the UI flow through a Firestore `commands` collection: the UI writes a command document, and the daemon — subscribed to that collection via the admin-SDK [`Db.subscribe`](../../ARCHITECTURE.md) seam — picks it up and acts.

## Command model

A command is a document in the `commands` collection (`CommandSchema`, validated like every other collection). Its `type` is a [`CommandType`](../../src/db/schemas/enums.ts):

| `CommandType`      | Effect                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `pause_run`        | Sets `paused: true` on the targeted `workflowRuns` document — a derived hold.             |
| `resume_run`       | Clears `paused` on the targeted run, so the scheduler resumes admitting its steps.        |
| `force_retry_step` | Re-enqueues the targeted `stepInstances` document as `pending`, clearing terminal fields. |

The `payload` names the target (`runId` for pause/resume, `stepInstanceId` for force-retry). `status` is a [`CommandStatus`](../../src/db/schemas/enums.ts) — a command is created `Pending`, and the listener moves it to `Handled` or `Failed`.

## Pause as a derived hold

Pause does not stop a worker mid-flight; it surfaces as a **derived hold** the scheduler honors. The scheduler's per-tick admission loop skips any step whose parent run has `paused: true`, leaving those steps `pending`. A `resume_run` command clears the flag, and the very next tick admits the steps again — **no manual unpark**, matching the lifecycle design's "park auto-resumes when its cause clears" principle ([PR-lifecycle design](../design/pr-lifecycle.md) §4, §7).

## Idempotency & failure recording

Re-delivery safety has two layers. First, the subscription is filtered to `Pending` documents and the listener writes a terminal status on completion, so an applied command leaves the processable set. Second, a re-delivered snapshot that races ahead of the terminal write is caught by an in-process handled-id set, so each command's effect runs at most once. Each effect is also individually idempotent (pausing an already-paused run, re-enqueuing an already-pending step) so a retried terminal write is safe.

Unknown or malformed commands are **recorded, never dropped**: a missing payload field or a target that does not exist throws a `CommandApplyError`, which the listener records as a `Failed` command with the error message, leaving an audit trail on the document.

## Public API

`src/engine/commands` exports `startCommandListener(db, options)` — returning a handle with `stop()` (detach) and `drain()` (await the in-flight snapshot) — and `applyCommand` / `CommandApplyError` for direct application.
