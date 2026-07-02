---
type: Index
title: PR Shepherd docs
description: OKF knowledge graph — curated reference pages an agent retrieves before a task.
---

# PR Shepherd documentation

These pages follow Google's [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md): one concept per markdown file with YAML frontmatter, cross-linked into a traversable graph. They are **pull/retrieval** reference knowledge — distinct from always-in-context policy, which lives in [CLAUDE.md](../CLAUDE.md) / [AGENTS.md](../AGENTS.md), and from the top-level overview in [ARCHITECTURE.md](../ARCHITECTURE.md).

## Frontmatter

Every page carries a `type` (the only OKF-required key) drawn from this vocabulary; `title`, `description`, `resource`, and `tags` are recommended-but-optional. `scripts/check-docs-okf.mjs` validates conformance.

| `type`          | Documents                                  |
| --------------- | ------------------------------------------ |
| `Subsystem`     | an `src/engine/*` module                   |
| `StepExecutor`  | a `src/steps/*` step executor              |
| `Adapter`       | an `src/db` data adapter                   |
| `Workflow`      | a `workflows/*.yaml` definition            |
| `Design`        | a design / goal-state document             |
| `Reference`     | general reference (setup, topology, …)     |
| `Index` / `Log` | the OKF directory listing / change history |

## Pages

### Subsystems

- [PR State Derivation](subsystems/pr-state-derivation.md) — one GitHub read → 8 orthogonal state axes.
- [Gate Model](subsystems/gate-model.md) — the total decision: a state vector walks an ordered gate table to one action.
- [Merge Serialization](subsystems/merge-serialization.md) — a single global merge path: one merge in flight at a time, idempotent on `(pr, headSha)`, with pre-merge re-validation splitting CI-running (defer) from CI-failed (fix).
- [Atomic-Task Guards](subsystems/atomic-task-guards.md) — pure cross-cutting guards (one-shot rerun, settle window, idempotency keys, verdict-label heal) that make atomic tasks safe to re-run.
- [Circuit Breakers](subsystems/circuit-breakers.md) — two queue-halting safety gates: CI-budget-exhausted (halt dispatch when the runner can't validate work) and main-broken (quarantine all but the fix-main PR when `main` is red).
- [Copilot Request Ladder](subsystems/copilot-request-ladder.md) — requests the automated reviewer at three precise moments (warmup / approval / merge-time) with refusal-vs-review separation and a bounded merge-time wait; Copilot is informational, never a hard merge gate.
- [Convergence & Loop Detection](subsystems/convergence.md) — catches non-converging fix→review loops without a hard round cap: a same-action-spin detector plus a durable-review-count cadence that escalates only flappers.
- [Commands Listener](subsystems/commands-listener.md) — the operator → daemon control plane: applies UI-issued pause / resume / force-retry commands to runs and steps, idempotently.
- [Engine Bootstrap](subsystems/engine-bootstrap.md) — the `shepherd start` boot sequence: config → admin Firestore → crash recovery → scheduler + commands listener → initial self-discovery, wired through injectable seams.
- [Event → Derivation Trigger](subsystems/event-derivation-trigger.md) — maps each persisted webhook delivery to the PR(s) it affects and re-seeds those tracked runs at the `derive_pr_state` lifecycle head; events touching no tracked PR drop cleanly. A trigger-source swap from poll to event, with no lifecycle change.
- [Event-Driven Scheduler](subsystems/event-driven-scheduler.md) — the scheduler ticks the instant state changes (debounced/coalesced) via Firestore subscriptions, with a low-frequency reconciliation poll as the fail-open safety net; events are a trigger, never a source of truth.
- [Execution Tick](subsystems/execution-tick.md) — drains `queued` steps through the runner and advances the completed ones; the orchestration half of the execution loop that pairs admission with advance (execution loop, part 2).
- [Graceful Shutdown](subsystems/graceful-shutdown.md) — SIGTERM/SIGINT halt the scheduler, drain in-flight steps within a bounded grace period, tear the daemon down, and exit (non-zero if the grace elapses) — never hanging.
- [Polling Reconciliation Fallback](subsystems/polling-reconciliation-fallback.md) — a low-frequency safety-net poll that re-derives PRs whose webhook deliveries were missed and rate-limits derivation triggered by event storms (token-bucket backpressure), so correctness never depends on webhooks alone; pairs with multi-secret zero-downtime webhook secret rotation.
- [Self-Discovery](subsystems/self-discovery.md) — each cycle recomputes the routable PR set from live state and enrolls newly-eligible PRs into runs idempotently.
- [Self-Observability](subsystems/self-observability.md) — a per-event audit stream plus a post-run self-analysis that derives merge-efficiency metrics and files issues for recurring anomalies (timeout-then-fast-retry, fix-review loops, high retry rate, duration outliers, merge failures, mass blocking).
- [Skill Outcome Protocol](subsystems/skill-outcome-protocol.md) — each skill posts one machine-readable outcome record onto the PR; the harness routes (retry / review / advance / escalate / fix / idle) purely off it.
- [Step Advance-on-Completion](subsystems/step-advance.md) — when a step completes, evaluate its routing and create the next step (or finish the run); the wiring that turns the routing DSL into a running workflow (execution loop, part 1).
- [Step Executor Contract](subsystems/step-executor-contract.md) — the runner ↔ executor contract: a terminal `ExecutorResult` plus a `StepExecutorRuntime` handle that lets `wait_*` executors persist `waiting`/heartbeat state mid-execution.
- [Wait-Set Orchestration & Stall/Liveness Defense](subsystems/wait-set-orchestration.md) — PRs blocked on CI/Copilot drain through one shared bulk poll instead of holding a worker; per-action hard timeouts, per-wait stall warnings, and a liveness watchdog defend against stalls and deadlock; graceful shutdown aggregates per-PR results on interrupt.
- [Webhook Delivery Consumer](subsystems/webhook-delivery-consumer.md) — drains the persisted webhook backlog into derivation cycles with delivery dedup (`processedAt`), per-PR burst-collapse, and replay/out-of-order tolerance; correctness comes from the idempotent derive→decide core, not from delivery order.
- [Webhook Receiver](subsystems/webhook-receiver.md) — GitHub webhook ingress: validates `X-Hub-Signature-256`, then persists each raw delivery to Firestore keyed by `X-GitHub-Delivery` before any processing, with Vercel-forward and local-tunnel topologies.
- [Workflow Hot-Reload](subsystems/workflow-hot-reload.md) — an in-memory registry of loaded workflow graphs that a file watcher refreshes on a `workflows/*.yaml` change, retaining the last-good definition when a hot edit fails validation.

### Step executors

- [claude_skill](steps/claude-skill.md) — runs a Claude skill in a capability-isolated subprocess.
- [evaluate_gates](steps/evaluate-gates.md) — reads the derived state vector, runs the gate decision, emits `{ action, blockingGate }` for routing.

### Workflows

- [base-pr](workflows/base-pr.md) — the central PR lifecycle: derive → gates → {review / fix / merge / wait\_\*}, re-deriving every tick.
- [dependabot-pr](workflows/dependabot-pr.md) — the Dependabot PR lifecycle: reuses base-pr's spine, layering mergeable / spawn-fix / rebase classification on the same gate decision.
- [dependabot-fix](workflows/dependabot-fix.md) — the stripped-down child a Dependabot PR forks to repair a CI failure: implement-fix → review → merge.

### Design

- [PR Lifecycle — Goal-State Design](design/pr-lifecycle.md) — the derive → decide → execute lifecycle, state vector, gate model, and orchestration/resilience target state.

### Reference

- [Local Development](local-development.md) — running the daemon against the Firebase Emulator.
- [shepherd CLI](reference/shepherd-cli.md) — the headless daemon's commander entrypoint: start, status, force-retry, inspect.
- [PM2 ecosystem (optional)](reference/pm2-ecosystem.md) — optional PM2 process file supervising `shepherd start` with auto-restart and exponential backoff.
