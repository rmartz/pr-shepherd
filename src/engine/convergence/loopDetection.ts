import type { Action } from "@/engine/gates";

// ---------------------------------------------------------------------------
// Same-action loop detection (issue #105).
//
// Stops an obvious spin — an action runs and the PR routes straight back to the
// SAME action with no intervening state change (a review that posted no
// verdict, a fix that resolved nothing). Detected structurally, not by a hard
// round cap (which would wrongly punish a genuinely large, still-converging
// PR): a state change produces a different fingerprint, which breaks the run.
//
// One transient retry is allowed — the same action may repeat once (a flake /
// re-poll) before it counts as a spin. With the default `maxConsecutive` of 3,
// a trailing run of 3 identical (action + fingerprint) ticks is a spin.
// ---------------------------------------------------------------------------

export enum LoopVerdict {
  Progressing = "progressing",
  Spinning = "spinning",
}

// One scheduler tick's decision: the action taken and a fingerprint of the PR
// state it was taken against. Identical consecutive `(action, stateFingerprint)`
// means the action ran and nothing changed — the spin signal.
export interface ActionTick {
  action: Action;
  stateFingerprint: string;
}

const DEFAULT_MAX_CONSECUTIVE = 3;

// Verdict for the trailing run of identical action+state. `Spinning` once the
// run reaches `maxConsecutive`; `Progressing` otherwise (including when the
// state changed, which breaks the run).
export function detectSameActionLoop(
  ticks: readonly ActionTick[],
  options: { maxConsecutive?: number } = {},
): LoopVerdict {
  const maxConsecutive = options.maxConsecutive ?? DEFAULT_MAX_CONSECUTIVE;
  if (ticks.length < maxConsecutive) return LoopVerdict.Progressing;

  const last = ticks[ticks.length - 1];
  if (last === undefined) return LoopVerdict.Progressing;
  let run = 0;
  for (let i = ticks.length - 1; i >= 0; i -= 1) {
    const tick = ticks[i];
    if (
      tick?.action !== last.action ||
      tick.stateFingerprint !== last.stateFingerprint
    ) {
      break;
    }
    run += 1;
  }
  return run >= maxConsecutive ? LoopVerdict.Spinning : LoopVerdict.Progressing;
}
