import { describe, it, expect } from "vitest";
import { Action } from "@/engine/gates";
import {
  detectSameActionLoop,
  LoopVerdict,
  type ActionTick,
} from "./loopDetection";

function tick(action: Action, stateFingerprint: string): ActionTick {
  return { action, stateFingerprint };
}

describe("detectSameActionLoop stops a same-action spin", () => {
  it("treats a trailing run of three identical action+state ticks as spinning", () => {
    const ticks = [
      tick(Action.FixReview, "s0"),
      tick(Action.FixReview, "s0"),
      tick(Action.FixReview, "s0"),
    ];
    expect(detectSameActionLoop(ticks)).toBe(LoopVerdict.Spinning);
  });

  it("allows one transient retry (two identical) without flagging a spin", () => {
    const ticks = [
      tick(Action.Review, "s1"),
      tick(Action.FixReview, "s2"),
      tick(Action.FixReview, "s2"),
    ];
    expect(detectSameActionLoop(ticks)).toBe(LoopVerdict.Progressing);
  });

  it("does not flag a spin when the state changed between same actions", () => {
    // Same action three times, but the fingerprint advances each tick → progress.
    const ticks = [
      tick(Action.FixReview, "s1"),
      tick(Action.FixReview, "s2"),
      tick(Action.FixReview, "s3"),
    ];
    expect(detectSameActionLoop(ticks)).toBe(LoopVerdict.Progressing);
  });

  it("does not flag a spin for differing trailing actions", () => {
    const ticks = [
      tick(Action.FixReview, "s0"),
      tick(Action.FixReview, "s0"),
      tick(Action.Review, "s0"),
    ];
    expect(detectSameActionLoop(ticks)).toBe(LoopVerdict.Progressing);
  });

  it("is progressing for a history shorter than the threshold", () => {
    expect(detectSameActionLoop([tick(Action.Merge, "s0")])).toBe(
      LoopVerdict.Progressing,
    );
  });

  it("honors a custom maxConsecutive", () => {
    const ticks = [tick(Action.WaitCi, "s0"), tick(Action.WaitCi, "s0")];
    expect(detectSameActionLoop(ticks, { maxConsecutive: 2 })).toBe(
      LoopVerdict.Spinning,
    );
  });
});
