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
- [Atomic-Task Guards](subsystems/atomic-task-guards.md) — pure cross-cutting guards (one-shot rerun, settle window, idempotency keys, verdict-label heal) that make atomic tasks safe to re-run.
- [Self-Discovery](subsystems/self-discovery.md) — each cycle recomputes the routable PR set from live state and enrolls newly-eligible PRs into runs idempotently.

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
