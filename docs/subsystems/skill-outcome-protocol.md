---
type: Subsystem
title: Skill Outcome Protocol
description: Every skill posts one machine-readable outcome record onto the PR; the harness routes purely off it.
resource: src/engine/outcome
tags: [lifecycle, routing, resilience, github]
---

# Skill Outcome Protocol

Every daemon-shipped skill (`/review`, `/fix-review`, `/merge`, `/triage`, …) ends by posting **one structured, machine-readable outcome record** onto the PR. That comment **is** the durable source of truth for "what did the last run of this step decide" — it survives daemon restarts with no local state, keeping the system consistent with the derive-from-GitHub / never-store principle (see [PR Lifecycle](../design/pr-lifecycle.md)).

A skill that timed out or crashed without recording an outcome is then unambiguously distinguishable from one that legitimately decided "no action": the absence of a record means retry; a `no_op` record means idle.

## The record

`SkillOutcomeRecord` carries: `skill`, `skillVersion`, `gitHash`, `outcome`, `runId`, `stepInstanceId`, `headSha`, and `timestamp`. It is serialized into a hidden HTML-comment marker — `<!-- skill-outcome: {json} -->` — invisible in rendered markdown but trivially parseable from raw comment text. This ports the coordinator POC's `skill-meta` marker (rmartz/dotfiles#1163) to a typed form.

## The outcome enum (closed set)

`SkillOutcome` is a string enum, alphabetized, values matching the marker:

- `approve` — gate satisfied; advance.
- `error` — the skill itself failed (distinct from a reject verdict).
- `hard_reject` — cannot proceed automatically; escalate to a human.
- `no_op` — nothing to do this cycle (legitimately idle, distinct from a crash).
- `soft_reject` — changes requested but converging; route to fix.

## Four stages

1. **Emit** — `buildOutcomeAction({ repo, pr, record })` renders the marker plus a one-line human summary and returns a `post_comment` **`github_api`** action. The skill never posts directly: a `claude_skill` subprocess has its GitHub credentials scrubbed (vision §4.3), so the only path to post is the `github_api` queue. One shared renderer keeps the format uniform and tamper-resistant.
2. **Parse** — `parseOutcomeMarker(body)` extracts a record from any comment body, returning `undefined` for non-outcome comments and malformed / out-of-enum markers.
3. **Derive** — extends [PR State Derivation](pr-state-derivation.md): `latestOutcomePerSkill(comments)` surfaces the most recent outcome per skill; `newCommentSinceOutcome(comments, skill)` reports whether a human/Copilot comment landed after that skill's last outcome.
4. **Route** — `routeOnOutcome({ comments, skill, currentHeadSha })` returns one `OutcomeRoute`, encoding the resilience rules (first match wins):

   | Condition                                 | Route      |
   | ----------------------------------------- | ---------- |
   | no outcome record (timeout / crash)       | `retry`    |
   | outcome on a superseded HEAD SHA          | `retry`    |
   | `error` outcome                           | `retry`    |
   | new non-outcome comment since the outcome | `review`   |
   | `hard_reject`                             | `escalate` |
   | `approve` on current HEAD                 | `advance`  |
   | `soft_reject`                             | `fix`      |
   | `no_op`                                   | `idle`     |

This is the bridge between the **decide** layer (gates, Epic 10) and the **execute/resilience** layer (retry, stall defense, loop detection — #105/#107/#110): those consumers all key off the same record rather than re-implementing "did the last step decide what".

## Public API

Exported from `src/engine/outcome` (`index.ts`): `SkillOutcome`, `SkillOutcomeRecord`, `renderOutcomeMarker`, `parseOutcomeMarker`, `buildOutcomeAction`, `latestOutcomePerSkill`, `newCommentSinceOutcome`, `OutcomeRoute`, `routeOnOutcome`.

## Related

- [PR State Derivation](pr-state-derivation.md) — supplies the `IssueCommentSnapshot[]` the outcome signals read.
- [Gate Model](gate-model.md) — the decide layer whose verdict an `approve` outcome advances past.
