import type { PrSnapshot } from "@/engine/derivation";
import {
  actualCopilotReviewCoversHead,
  isCopilotRefusalOnly,
} from "./coverage";

// ---------------------------------------------------------------------------
// Merge-time Copilot wait (Event B, issue #106).
//
// After the merge-time request (Event B) fires, the daemon waits a BOUNDED
// window for Copilot to respond — Copilot is informational, never a hard merge
// gate. The wait resolves three ways:
//
//   Proceed — no actual review arrived within the cap, OR a refusal/outage
//             notice landed (a refusal CLEARS the wait but is NOT a review), OR
//             a review arrived with no open findings → merge may proceed.
//   Defer   — an actual review covering HEAD arrived WITH open findings (open
//             Copilot threads): hand back to the next route pass so the findings
//             are addressed before merge.
//   Wait    — still within the window and Copilot has neither reviewed nor
//             refused: keep waiting (re-poll).
//
// This is a pure function of the fresh snapshot plus elapsed/cap timing. The
// caller owns the clock and the re-poll loop.
// ---------------------------------------------------------------------------

export enum CopilotWaitOutcome {
  Defer = "defer", // review with open findings → next route pass addresses them
  Proceed = "proceed", // cap exceeded, refusal, or clean review → merge may go
  Wait = "wait", // still within window, no response yet → re-poll
}

export interface CopilotWaitInput {
  snapshot: PrSnapshot;
  // Whether any Copilot-authored review thread is currently open (unresolved,
  // not outdated). Supplied by the caller from the same snapshot so this stays a
  // single source of truth with the Threads/Copilot axes.
  hasOpenCopilotFindings: boolean;
  // Milliseconds elapsed since the merge-time request was placed.
  elapsedMs: number;
  // The bounded wait cap (default ~20 min). Once elapsed >= cap, proceed.
  capMs: number;
}

export function assessCopilotMergeWait(
  input: CopilotWaitInput,
): CopilotWaitOutcome {
  // An actual review covering HEAD landed.
  if (actualCopilotReviewCoversHead(input.snapshot)) {
    return input.hasOpenCopilotFindings
      ? CopilotWaitOutcome.Defer
      : CopilotWaitOutcome.Proceed;
  }
  // A refusal/outage clears the wait (advance) but is not a review.
  if (isCopilotRefusalOnly(input.snapshot)) {
    return CopilotWaitOutcome.Proceed;
  }
  // No response yet: proceed once the cap is exceeded, otherwise keep waiting.
  return input.elapsedMs >= input.capMs
    ? CopilotWaitOutcome.Proceed
    : CopilotWaitOutcome.Wait;
}

// Default bounded merge-time wait: 20 minutes.
export const DEFAULT_COPILOT_WAIT_CAP_MS = 20 * 60 * 1000;
