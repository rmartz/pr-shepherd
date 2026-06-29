import { describe, it, expect } from "vitest";
import { VerdictLabel, healVerdict, reconcileVerdict } from "../verdict-labels";

describe("Atomic verdict-label reconciliation: applying one removes the rest", () => {
  it("removes every contradictory verdict when applying approved", () => {
    const labels = [
      "changes requested",
      "review requested",
      "escalation needed",
      "Engine",
    ];
    const mutation = reconcileVerdict(VerdictLabel.Approved, labels);
    expect(mutation.add).toEqual(["approved"]);
    expect(mutation.remove.sort()).toEqual(
      ["changes requested", "escalation needed", "review requested"].sort(),
    );
  });

  it("leaves non-verdict labels (e.g. domain labels) untouched", () => {
    const labels = ["changes requested", "Engine", "Security"];
    const mutation = reconcileVerdict(VerdictLabel.Approved, labels);
    expect(mutation.remove).toEqual(["changes requested"]);
    expect(mutation.remove).not.toContain("Engine");
    expect(mutation.remove).not.toContain("Security");
  });

  it("is a no-op when the PR already carries exactly the target verdict", () => {
    const mutation = reconcileVerdict(VerdictLabel.Approved, [
      "approved",
      "Engine",
    ]);
    expect(mutation.add).toEqual([]);
    expect(mutation.remove).toEqual([]);
  });
});

describe("Atomic verdict-label reconciliation: heal contradictory labels", () => {
  it("heals a PR carrying two contradictory verdicts toward the urgent one", () => {
    const mutation = healVerdict(["approved", "changes requested", "Engine"]);
    expect(mutation.add).toEqual([]);
    expect(mutation.remove).toEqual(["approved"]);
  });

  it("keeps escalation needed over every other verdict when healing", () => {
    const mutation = healVerdict([
      "approved",
      "changes requested",
      "review requested",
      "escalation needed",
    ]);
    expect(mutation.remove.sort()).toEqual(
      ["approved", "changes requested", "review requested"].sort(),
    );
  });

  it("is a no-op when at most one verdict label is present", () => {
    expect(healVerdict(["approved", "Engine"])).toEqual({
      add: [],
      remove: [],
    });
    expect(healVerdict(["Engine"])).toEqual({ add: [], remove: [] });
  });

  // Guards against the tech-debt failure mode (#194): if precedence ever stops
  // covering a `VerdictLabel` member, the winner would be undefined and the heal
  // would strip *all* present verdicts. Healing every full set of verdicts must
  // always keep exactly one — the highest-precedence — so exactly one survives.
  it("always keeps exactly one verdict when every verdict is present", () => {
    const allVerdicts = Object.values(VerdictLabel);
    const mutation = healVerdict(allVerdicts);
    expect(mutation.remove).toHaveLength(allVerdicts.length - 1);
    expect(mutation.remove).not.toContain(VerdictLabel.EscalationNeeded);
  });

  it("keeps the higher-precedence verdict in every pairwise contradiction", () => {
    // Most → least urgent. Each earlier member must survive against each later.
    const byPrecedence = [
      VerdictLabel.EscalationNeeded,
      VerdictLabel.ChangesRequested,
      VerdictLabel.ReviewRequested,
      VerdictLabel.Approved,
    ];
    byPrecedence.forEach((winner, i) => {
      byPrecedence.slice(i + 1).forEach((loser) => {
        const mutation = healVerdict([loser, winner]);
        expect(mutation.remove).toEqual([loser]);
      });
    });
  });
});
