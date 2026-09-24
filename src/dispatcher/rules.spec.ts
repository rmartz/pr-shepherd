import { describe, expect, it } from "vitest";
import type { DispatchRule } from "./rules";
import { buildSearchQuery, DISPATCH_RULES } from "./rules";

const RULE: DispatchRule = {
  name: "approved",
  skill: "/merge",
  filter: 'label:"approved"',
};

describe("buildSearchQuery", () => {
  it("narrows to the owner's repos when an owner is given", () => {
    expect(buildSearchQuery(RULE, "rmartz")).toContain(" user:rmartz ");
  });

  it("omits the owner qualifier when no owner is given", () => {
    expect(buildSearchQuery(RULE)).not.toContain("user:");
  });

  it("appends the rule's label filter", () => {
    expect(buildSearchQuery(RULE, "rmartz")).toContain('label:"approved"');
  });
});

describe("DISPATCH_RULES", () => {
  it("routes merge conflicts ahead of merging", () => {
    const names = DISPATCH_RULES.map((rule) => rule.name);
    expect(names.indexOf("merge-conflict")).toBeLessThan(
      names.indexOf("approved"),
    );
  });
});
