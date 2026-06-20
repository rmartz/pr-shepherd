import { describe, it, expect } from "vitest";
import { SettleVerdict, settleGuard } from "../settle-window";
import { makeSettleInput } from "./fixtures";

describe("Settle window: a visible change concludes immediately", () => {
  it("returns Changed when the observation already differs", () => {
    const input = makeSettleInput({
      before: "labels:[review requested]",
      after: "labels:[approved]",
      settleSpent: false,
    });
    expect(settleGuard(input)).toBe(SettleVerdict.Changed);
  });
});

describe("Settle window: unchanged observation waits once before concluding", () => {
  it("returns Settle when unchanged and no settle has been spent", () => {
    const input = makeSettleInput({
      before: "labels:[approved]",
      after: "labels:[approved]",
      settleSpent: false,
    });
    expect(settleGuard(input)).toBe(SettleVerdict.Settle);
  });

  it("returns Unchanged when the recheck after settling is still unchanged", () => {
    const input = makeSettleInput({
      before: "labels:[approved]",
      after: "labels:[approved]",
      settleSpent: true,
    });
    expect(settleGuard(input)).toBe(SettleVerdict.Unchanged);
  });

  it("concludes Changed if the write becomes visible after settling", () => {
    const input = makeSettleInput({
      before: "labels:[approved]",
      after: "labels:[approved, tested]",
      settleSpent: true,
    });
    expect(settleGuard(input)).toBe(SettleVerdict.Changed);
  });
});
