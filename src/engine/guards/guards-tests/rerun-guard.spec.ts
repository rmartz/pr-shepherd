import { describe, it, expect } from "vitest";
import {
  MAX_RERUNS_PER_COMMIT,
  RerunVerdict,
  recordRerun,
  rerunGuard,
} from "../rerun-guard";
import { makeRerunLedger } from "./fixtures";

const HEAD = "commit-head-oid";

describe("One-shot rerun guard: CANCELLED → RERUN_CI exactly once", () => {
  it("permits a rerun when the commit has spent no reruns", () => {
    const ledger = makeRerunLedger([["some-other-commit", 1]]);
    expect(rerunGuard(HEAD, ledger)).toBe(RerunVerdict.Rerun);
  });

  it("escalates when the commit has already spent its one-shot rerun", () => {
    const ledger = makeRerunLedger([[HEAD, MAX_RERUNS_PER_COMMIT]]);
    expect(rerunGuard(HEAD, ledger)).toBe(RerunVerdict.Escalate);
  });

  it("resets the budget for a new HEAD commit", () => {
    const ledger = makeRerunLedger([["old-commit", MAX_RERUNS_PER_COMMIT]]);
    expect(rerunGuard("new-commit", ledger)).toBe(RerunVerdict.Rerun);
  });
});

describe("One-shot rerun guard: second-cancel → escalate path", () => {
  it("escalates on the second infra-cancel of the same commit", () => {
    const empty = makeRerunLedger();
    expect(rerunGuard(HEAD, empty)).toBe(RerunVerdict.Rerun);

    const afterFirst = recordRerun(HEAD, empty);
    expect(rerunGuard(HEAD, afterFirst)).toBe(RerunVerdict.Escalate);
  });

  it("recordRerun returns a new ledger without mutating the input", () => {
    const before = makeRerunLedger();
    const after = recordRerun(HEAD, before);
    expect(before.has(HEAD)).toBe(false);
    expect(after.get(HEAD)).toBe(1);
  });
});
