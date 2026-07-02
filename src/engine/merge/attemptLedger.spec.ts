import { describe, it, expect } from "vitest";
import {
  buildAttemptMarker,
  countAttempts,
  parseAttemptMarker,
  type AttemptMarker,
} from "./attemptLedger";

// The ledger persists each transient merge failure as a hidden marker comment.
// These cover the pure primitives: build/parse round-trip and the count that
// encodes the two SHA-keyed reset signals (new HEAD, cleared escalation label).

describe("attempt markers round-trip through build and parse", () => {
  it("parses back the sha and timestamp a built marker encoded", () => {
    const marker = buildAttemptMarker("cafe123", 1700);

    expect(parseAttemptMarker(marker)).toEqual({
      headSha: "cafe123",
      at: 1700,
    });
  });

  it("returns undefined for an ordinary comment that is not a marker", () => {
    expect(parseAttemptMarker("LGTM, merging shortly")).toBeUndefined();
  });
});

describe("countAttempts scopes the budget to the current HEAD", () => {
  const markers: AttemptMarker[] = [
    { headSha: "sha-old", at: 100 },
    { headSha: "sha-new", at: 200 },
    { headSha: "sha-new", at: 300 },
  ];

  it("counts only markers for the given HEAD (reset on a new commit)", () => {
    expect(countAttempts(markers, "sha-new")).toBe(2);
  });

  it("discounts markers written before the escalation label was cleared", () => {
    // A human cleared `escalation needed` at t=250, so only the t=300 marker
    // still counts against the budget (reset on a server-side fix, no push).
    expect(countAttempts(markers, "sha-new", 250)).toBe(1);
  });
});
