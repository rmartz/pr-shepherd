import { describe, it, expect } from "vitest";
import { findPinViolations } from "./check-action-pins.mjs";

const SHA = "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";

describe("findPinViolations flags unpinned third-party actions", () => {
  it("flags a bare tag pin", () => {
    const violations = findPinViolations("      - uses: actions/checkout@v7\n");
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/SHA/);
  });

  it("flags a SHA pin missing a version comment", () => {
    const violations = findPinViolations(
      `      - uses: actions/checkout@${SHA}\n`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/comment/);
  });

  it("flags a reusable workflow pinned by tag", () => {
    const violations = findPinViolations(
      "    uses: owner/repo/.github/workflows/scan.yml@v5.1.0\n",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toMatch(/SHA/);
  });
});

describe("findPinViolations accepts SHA pins with a version comment", () => {
  it("passes an action pinned to a SHA with a version comment", () => {
    expect(
      findPinViolations(`      - uses: actions/checkout@${SHA} # v7.0.0\n`),
    ).toEqual([]);
  });

  it("passes a SHA-pinned reusable workflow with a version comment", () => {
    expect(
      findPinViolations(
        `    uses: owner/repo/.github/workflows/scan.yml@${SHA} # v5.1.0\n`,
      ),
    ).toEqual([]);
  });
});

describe("findPinViolations exempts local references", () => {
  it("ignores a local composite-action use", () => {
    expect(
      findPinViolations("      - uses: ./.github/actions/setup\n"),
    ).toEqual([]);
  });
});
