import { describe, it, expect } from "vitest";

import { formatDurationMs } from "./format";

describe("formatDurationMs", () => {
  it("formats sub-second durations in milliseconds", () => {
    expect(formatDurationMs(999)).toBe("999ms");
  });

  it("formats sub-minute durations with one decimal second", () => {
    expect(formatDurationMs(1500)).toBe("1.5s");
  });

  it("formats durations at the minute rollover boundary", () => {
    expect(formatDurationMs(59_950)).toBe("1m 0s");
  });

  it("formats multi-minute rollover correctly", () => {
    expect(formatDurationMs(119_960)).toBe("2m 0s");
  });

  it("formats clean multi-minute durations", () => {
    expect(formatDurationMs(90_000)).toBe("1m 30s");
  });
});
