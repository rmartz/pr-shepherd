---
type: Reference
title: Open Knowledge Format (OKF)
description: What OKF is, how pr-shepherd's docs/ tree applies it, how CI enforces it, and where the authoritative spec lives.
tags: [documentation, okf, knowledge-graph, conventions]
---

# Open Knowledge Format (OKF)

The **Open Knowledge Format (OKF)** is the convention the `docs/` tree follows: knowledge is
written as small, single-concept Markdown files, each carrying YAML frontmatter, cross-linked into
a graph an agent (or a person) can traverse to retrieve exactly the context a task needs.

> **Authoritative spec.** OKF is defined by Google's
> [Open Knowledge Format specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).
> That document is the source of truth for any question about the format itself — the frontmatter
> grammar, reserved keys, and semantics. This page describes only how pr-shepherd _applies_ OKF;
> where the two ever appear to disagree, the spec wins.

## Why we use it

These pages are **pull/retrieval reference knowledge** — read on demand before a task — as opposed
to always-in-context policy, which lives in [`CLAUDE.md`](../../CLAUDE.md) / [`AGENTS.md`](../../AGENTS.md),
and the top-level overview in [`ARCHITECTURE.md`](../../ARCHITECTURE.md). Keeping each concept in its
own small, typed, cross-linked file means an agent can load the two or three pages relevant to a task
instead of one monolithic document, and the `type` vocabulary lets the graph be filtered by category.

## How pr-shepherd applies OKF

- **One concept per file.** Each page documents a single concept — such as a subsystem, step
  executor, adapter, workflow, design, reference topic, index, or log.
- **Frontmatter.** Every page begins with a `---` … `---` YAML block. The only OKF-required key is
  `type`, constrained here to a fixed vocabulary (`Subsystem`, `StepExecutor`, `Adapter`, `Workflow`,
  `Design`, `Reference`, `Index`, `Log`) so the graph is navigable by category. `title`, `description`,
  `resource`, and `tags` are recommended but optional. The vocabulary table lives in
  [`docs/index.md`](../index.md).
- **A navigable graph.** [`docs/index.md`](../index.md) is the root `Index` page; every page is
  reachable from it by following Markdown links, and pages cross-link related concepts directly.

## How it is enforced

Two zero-review CI checks keep the tree conformant (both gated to `docs/**` and the two validator
scripts in the **Validate Docs** workflow):

- [`scripts/check-docs-okf.mjs`](../../scripts/check-docs-okf.mjs) — every page has frontmatter with a
  `type` drawn from the allowed vocabulary.
- [`scripts/check-docs-index.mjs`](../../scripts/check-docs-index.mjs) — every page is reachable from
  [`docs/index.md`](../index.md) by navigating index-to-index links, so nothing is orphaned from the graph.

When you add a page, give it valid frontmatter and link it from an `index.md` (today, the root
[`docs/index.md`](../index.md)); the checks above fail the build otherwise.

## Related

- [`docs/index.md`](../index.md) — the OKF root index and the `type` vocabulary table.
