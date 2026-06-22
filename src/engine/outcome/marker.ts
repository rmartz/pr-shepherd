import { SkillOutcome, type SkillOutcomeRecord } from "./types";

// ---------------------------------------------------------------------------
// Outcome comment render + parse (Epic 11, #151).
//
// The record is serialized into a hidden HTML-comment marker — invisible in
// rendered markdown but trivially parseable from raw comment text during
// derivation. This ports the POC's `<!-- skill-meta: {json} -->` shape
// (rmartz/dotfiles#1163) to a typed, productionalized form. The payload is
// snake_case so the on-wire marker reads naturally and matches the serialized
// axis-enum convention used elsewhere in the codebase.
//
// A single PR comment carries at most one marker. `parseOutcomeComment`
// returns `undefined` for any comment without a well-formed marker (a human's
// free-form comment, a Copilot review, etc.) so the caller can cleanly
// distinguish "an outcome record" from "some other comment".
// ---------------------------------------------------------------------------

const MARKER_PREFIX = "<!-- skill-outcome:";
const MARKER_SUFFIX = "-->";

// Matches the marker anywhere in a comment body and captures its JSON payload.
// `[\s\S]` (rather than the `s` dotall flag, unavailable below es2018) lets the
// payload span newlines; non-greedy so trailing prose after the marker parses.
const MARKER_RE = /<!--\s*skill-outcome:\s*(\{[\s\S]*?\})\s*-->/;

// The serialized (snake_case) shape of the payload inside the marker.
interface OutcomeMarkerPayload {
  skill: string;
  skill_version: string;
  git_hash: string;
  outcome: string;
  run_id: string;
  step_instance_id: string;
  head_sha: string;
  timestamp: string;
}

// Render the hidden marker for a record. Returned standalone so a skill's
// human-readable comment body can be concatenated around it by the emitter.
export function renderOutcomeMarker(record: SkillOutcomeRecord): string {
  const payload: OutcomeMarkerPayload = {
    skill: record.skill,
    skill_version: record.skillVersion,
    git_hash: record.gitHash,
    outcome: record.outcome,
    run_id: record.runId,
    step_instance_id: record.stepInstanceId,
    head_sha: record.headSha,
    timestamp: record.timestamp,
  };
  return `${MARKER_PREFIX} ${JSON.stringify(payload)} ${MARKER_SUFFIX}`;
}

// Parse an outcome record out of a PR comment body. Returns `undefined` when
// the body carries no marker, the marker's JSON is malformed, a required field
// is missing, or the `outcome` is not a member of the closed enum — i.e. only
// a fully well-formed record round-trips.
export function parseOutcomeMarker(
  body: string,
): SkillOutcomeRecord | undefined {
  const match = MARKER_RE.exec(body);
  const json = match?.[1];
  if (json === undefined) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const p = raw as Record<string, unknown>;
  const outcome = toOutcome(p["outcome"]);
  if (outcome === undefined) return undefined;

  const skill = stringField(p["skill"]);
  const skillVersion = stringField(p["skill_version"]);
  const gitHash = stringField(p["git_hash"]);
  const runId = stringField(p["run_id"]);
  const stepInstanceId = stringField(p["step_instance_id"]);
  const headSha = stringField(p["head_sha"]);
  const timestamp = stringField(p["timestamp"]);
  if (
    skill === undefined ||
    skillVersion === undefined ||
    gitHash === undefined ||
    runId === undefined ||
    stepInstanceId === undefined ||
    headSha === undefined ||
    timestamp === undefined
  ) {
    return undefined;
  }

  return {
    skill,
    skillVersion,
    gitHash,
    outcome,
    runId,
    stepInstanceId,
    headSha,
    timestamp,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toOutcome(value: unknown): SkillOutcome | undefined {
  if (typeof value !== "string") return undefined;
  return (Object.values(SkillOutcome) as string[]).includes(value)
    ? (value as SkillOutcome)
    : undefined;
}
