---
type: StepExecutor
title: claude_skill
description: Runs a Claude skill in a capability-isolated subprocess and returns its parsed output.
resource: src/steps/claudeSkill.ts
tags: [steps, claude, subprocess, isolation]
---

# `claude_skill` step executor

Spawns a `claude` subprocess for a step's skill, streams its output into the step's logs, heartbeats while it runs, and returns the parsed response as the step output. A non-zero exit throws, which the runner records as a failed step.

## Capability isolation (hard rule)

The subprocess is spawned with `GITHUB_TOKEN`, `GH_TOKEN`, and any GitHub-MCP credential env var **scrubbed** (`scrubGithubEnv`), so a Claude skill physically cannot call `gh` or a GitHub MCP tool. All GitHub mutation must instead flow through the `github_api` step queue — that structural guarantee is what makes the GitHub-API concurrency cap meaningful.

## Lifecycle

- **Heartbeat** — writes `heartbeatAt` on an interval so the heartbeat monitor can recover a hung subprocess.
- **Cancellation** — aborting the injected signal sends `SIGTERM`, then `SIGKILL` after a grace period.
- **Output** — stdout is parsed as JSON into the step output (falling back to `{ raw }`); stdout/stderr lines are persisted to the step's `logs`.
- **Metrics** — the executor does **not** write `metrics.claudeMs`; the runner derives it from the step's running duration to avoid double-counting.

## Public API

Exported from `src/steps/claudeSkill.ts`: `createClaudeSkillExecutor(db, options?)`, `ClaudeSkillInputSchema`, `scrubGithubEnv`, and the `SpawnedProcess` / `CreateClaudeSkillExecutorOptions` types. The executor is constructed via the factory so the runner can inject `db` (and tests can inject a fake `spawn`).

## Related

- [PR State Derivation](../subsystems/pr-state-derivation.md) — supplies the state the workflow's gates act on before a `claude_skill` step runs.
