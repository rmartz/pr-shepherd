// ---------------------------------------------------------------------------
// Skill outcome protocol types (Epic 11, #151).
//
// Every daemon-shipped skill (`/review`, `/fix-review`, `/merge`, `/triage`, …)
// ends by posting ONE structured, machine-readable outcome record onto the PR.
// That comment IS the durable source of truth for "what did the last run of
// this step decide" — it survives daemon restarts with no local state, keeping
// the system consistent with the derive-from-GitHub / never-store principle.
//
// This module owns only the data shapes. `marker.ts` renders/parses the
// comment, `emit.ts` turns a record into a capability-isolated github_api
// action, `derive.ts` surfaces the derived signals, and `route.ts` routes the
// harness off them.
// ---------------------------------------------------------------------------

// The closed outcome set. String values match the serialized marker and are
// kept in alphabetical order per the repo enum convention. The harness routes
// purely off these members, so they are a contract — not free text.
//
//  - Approve     — the step's gate is satisfied; advance to the next gate/step.
//  - Error       — the skill itself failed (distinct from a reject verdict).
//  - HardReject  — cannot proceed automatically; escalate to a human.
//  - NoOp        — nothing to do this cycle (legitimately idle — distinct from
//                  a crashed/timed-out run that posted no record at all).
//  - SoftReject  — changes requested but converging; route to fix and expect
//                  another cycle.
export enum SkillOutcome {
  Approve = "approve",
  Error = "error",
  HardReject = "hard_reject",
  NoOp = "no_op",
  SoftReject = "soft_reject",
}

// The full machine-readable record carried by an outcome comment. Every field
// is emitted by the shared helper so the format is uniform across skills.
export interface SkillOutcomeRecord {
  // The skill that ran: `review`, `fix_review`, `merge`, `triage`, …. Used to
  // group "most recent outcome per step".
  skill: string;
  // Version of the skill definition that ran — lets an outcome posted by an
  // older skill version be re-evaluated when the skill changes.
  skillVersion: string;
  // The commit the daemon/skill bundle was built from (provenance).
  gitHash: string;
  // The decided outcome (closed enum above).
  outcome: SkillOutcome;
  // The workflow run id that produced this outcome.
  runId: string;
  // The step instance id within that run.
  stepInstanceId: string;
  // The PR HEAD the outcome was computed against — makes "is this outcome
  // stale?" decidable (an outcome on a superseded HEAD is stale).
  headSha: string;
  // ISO-8601 timestamp the outcome was emitted.
  timestamp: string;
}
