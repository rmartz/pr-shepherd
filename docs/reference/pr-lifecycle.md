---
type: Reference
title: pr-lifecycle (shared rmartz/pr-lifecycle-action)
description: The pull_request_target caller that runs the shared @rmartz/pr-lifecycle reconciler without arming, keeping each PR's lifecycle and UAT labels in step with its current facts and posting the pr-lifecycle/sign-off status.
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
`UAT passed` on each PR. The [pr-policy](pr-policy.md) gate reads the sign-off status this posts.

**No arming.** `arm-auto-merge` is off, so it never arms, merges, or updates a branch. It runs as
the `rmartz-pr-lifecycle` App and posts the `pr-lifecycle/sign-off` status, which the
[pr-policy](pr-policy.md) gate trusts from `rmartz-pr-lifecycle[bot]`.

**Triggers.** It runs on `pull_request_target` and never checks out PR code. `workflow_run` lists
the workflows behind the required checks (`CI`, `Repo Hygiene`, `Storybook Tests`, `pr-policy`);
keep it in step if a required check moves.

The caller follows the action's
[consumer guide](https://github.com/rmartz/pr-lifecycle-action/blob/main/docs/consuming.md).
