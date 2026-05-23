import { describe, it, expect } from "vitest";

describe("node project smoke test", () => {
  it("runs in node environment", () => {
    expect(1 + 1).toBe(2);
  });
});
