---
type: Workflow
title: dependabot-fix
description: The stripped-down child workflow a Dependabot PR forks to repair a CI failure — implement-fix → review → merge.
resource: workflows/dependabot-fix.yaml
tags: [workflow, pr-lifecycle, dependabot, fork]
---

# `dependabot-fix` workflow

The deliberately linear child workflow that a [`dependabot-pr`](dependabot-pr.md) run forks (via its `spawn_fix_pr` step) when a Dependabot PR is CI-failing & fixable. It implements the fix, reviews it, and merges it — and does **not** re-run the full derive → gates lifecycle: the parent `dependabot-pr` run owns the classification loop and waits on this child through its `wait_fix_pr` step. See [PR Lifecycle — Goal-State Design §5.2](../design/pr-lifecycle.md).

## Shape

```
implement_fix → review → post_review → merge → post_merge
   (claude_skill)  (claude_skill → github_api)  (claude_skill → github_api)
```

1. **`implement_fix`** ([`claude_skill`](../steps/claude-skill.md), skill `implement-fix`) produces the fix commits on the fix-PR branch.
2. **`review`** renders a verdict, paired with the `post_review` `github_api` poster.
3. **`merge`** re-validates and emits the squash-merge intent, paired with the `post_merge` poster.

## Capability isolation

Capability isolation holds here exactly as in [`base-pr`](base-pr.md): each `claude_skill` step emits structured intent that its paired `github_api` poster carries out, and the [`claude_skill`](../steps/claude-skill.md) executor spawns the subprocess with GitHub credentials scrubbed so a skill physically cannot push.

## Related

- [`dependabot-pr`](dependabot-pr.md) — the parent workflow whose `spawn_fix_pr` step forks this one.
- [`base-pr`](base-pr.md) — the central lifecycle whose review/merge steps this workflow reuses.
- [PR Lifecycle — Goal-State Design](../design/pr-lifecycle.md) — §5.2 Dependabot lifecycle.
