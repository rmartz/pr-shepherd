// Public surface of the Copilot request-ladder module (issue #106).
//
// The ladder requests the automated reviewer at three precise moments (warmup /
// approval / merge-time) with refusal-vs-review separation, and bounds the
// merge-time wait so Copilot is informational, never a hard merge gate.
export {
  actualCopilotReviewCoversHead,
  hasActualCopilotReview,
  isCopilotRefusalOnly,
} from "./coverage";
export {
  assessCopilotMergeWait,
  CopilotWaitOutcome,
  DEFAULT_COPILOT_WAIT_CAP_MS,
  type CopilotWaitInput,
} from "./mergeWait";
export {
  CopilotRequestEvent,
  shouldRequestAtApproval,
  shouldRequestAtMergeTime,
  shouldRequestCopilot,
  shouldRequestWarmup,
  type CopilotLadderInput,
} from "./requestLadder";
