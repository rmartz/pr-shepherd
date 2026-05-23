import { describe, it, expect } from "vitest";

describe("hooks project smoke test", () => {
  it("runs in happy-dom environment", () => {
    expect(typeof window).toBe("object");
  });
});
