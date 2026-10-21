---
type: Reference
title: pr-lifecycle (shared rmartz/pr-lifecycle-action)
description: The labels-only pull_request_target caller that runs the shared @rmartz/pr-lifecycle reconciler, keeping each PR's lifecycle and UAT labels in step with its current facts.
resource: .github/workflows/pr-lifecycle.yml
tags: [ci, github-actions, pr-lifecycle, labels, uat, devops]
---

# pr-lifecycle (shared `rmartz/pr-lifecycle-action`)

[`.github/workflows/pr-lifecycle.yml`](../../.github/workflows/pr-lifecycle.yml) runs
[`rmartz/pr-lifecycle-action`](https://github.com/rmartz/pr-lifecycle-action) on every relevant
PR event: opens, pushes, labels, reviews, review requests, and CI completing. Each run recomputes
the PR's lifecycle state from its current facts and converges its labels (`approved`,
`changes requested`, `blocked`, `fix required`, `ci failing`, …).

**UAT.** With `uat: 'on'` it keeps exactly one of `no UAT needed`, `UAT pending`, `UAT ready`, or
`UAT passed` on each PR. The [pr-policy](pr-policy.md) gate still classifies UAT itself for now.

**Labels only.** `arm-auto-merge` is off and no real-actor `token` is passed, so it never arms,
merges, or updates a branch, and posts no `pr-lifecycle/sign-off` status. Reads and label writes
use the workflow's `GITHUB_TOKEN` until this repo has the `rmartz-merge-bot` App secrets.

**Triggers.** It runs on `pull_request_target` and never checks out PR code. `workflow_run` lists
the workflows behind the required checks (`CI`, `Repo Hygiene`, `Storybook Tests`, `pr-policy`);
keep it in step if a required check moves.

The caller follows the action's
[consumer guide](https://github.com/rmartz/pr-lifecycle-action/blob/main/docs/consuming.md).
