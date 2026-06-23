import { describe, it, expect } from "vitest";
import { assessMainBroken, isQuarantined } from "./mainBroken";

describe("assessMainBroken trips on a failed main push and recovers", () => {
  it("is broken and captures the bad SHA when the latest main run failed", () => {
    expect(assessMainBroken({ conclusion: "failure", sha: "bad-sha" })).toEqual(
      { broken: true, badSha: "bad-sha" },
    );
  });

  it("recovers (not broken) once the latest main run succeeds", () => {
    expect(
      assessMainBroken({ conclusion: "success", sha: "good-sha" }),
    ).toEqual({ broken: false });
  });
});

describe("isQuarantined exempts only the fix-main PR", () => {
  it("quarantines an ordinary PR while main is broken", () => {
    expect(isQuarantined(true, false)).toBe(true);
  });

  it("lets the designated fix-main PR through while main is broken", () => {
    expect(isQuarantined(true, true)).toBe(false);
  });

  it("quarantines nothing once main is healthy", () => {
    expect(isQuarantined(false, false)).toBe(false);
  });
});
