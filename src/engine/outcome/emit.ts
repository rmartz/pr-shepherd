import { GithubActionType, type GithubAction } from "@/steps/githubApi";
import { renderOutcomeMarker } from "./marker";
import { SkillOutcome, type SkillOutcomeRecord } from "./types";

// ---------------------------------------------------------------------------
// Shared outcome emitter (Epic 11, #151).
//
// Every daemon skill ends by handing its decided outcome to THIS one helper —
// never by posting its own outcome comment ad-hoc. The helper renders the
// uniform marker + a short human-readable summary and returns a `post_comment`
// `github_api` action. Routing the comment through `github_api` (rather than a
// direct `gh` call) is the capability-isolation rule (vision §4.3): a
// `claude_skill` subprocess has its GitHub credentials scrubbed, so the only
// path that can post is the `github_api` queue. Funnelling every skill through
// one renderer is what keeps the metadata format uniform and tamper-resistant.
//
// `buildOutcomeAction` is a pure function — it performs no I/O. The caller
// feeds the returned action into the `github_api` step's action batch, where
// it occupies one slot in the global GitHub-API concurrency budget like any
// other mutation.
// ---------------------------------------------------------------------------

// A one-line human-readable summary per outcome, shown above the hidden marker
// so the comment is meaningful to a person reading the PR timeline. Kept in
// the enum's alphabetical order to minimize merge conflicts.
const OUTCOME_SUMMARY: Record<SkillOutcome, string> = {
  [SkillOutcome.Approve]: "gate satisfied — advancing",
  [SkillOutcome.Error]: "skill failed to complete",
  [SkillOutcome.HardReject]:
    "cannot proceed automatically — escalating to a human",
  [SkillOutcome.NoOp]: "nothing to do this cycle",
  [SkillOutcome.SoftReject]: "changes requested — routing to fix",
};

export interface BuildOutcomeActionParams {
  repo: string;
  pr: number;
  record: SkillOutcomeRecord;
}

// Build the `post_comment` action that carries a skill's outcome record. The
// body is the human summary followed by the hidden marker; derivation reads
// the marker, humans read the summary.
export function buildOutcomeAction(
  params: BuildOutcomeActionParams,
): GithubAction {
  const { record } = params;
  const summary = OUTCOME_SUMMARY[record.outcome];
  const heading = `**\`/${record.skill}\` outcome: \`${record.outcome}\`** — ${summary}`;
  const body = `${heading}\n\n${renderOutcomeMarker(record)}`;
  return {
    type: GithubActionType.PostComment,
    params: { repo: params.repo, pr: params.pr, body },
  };
}
