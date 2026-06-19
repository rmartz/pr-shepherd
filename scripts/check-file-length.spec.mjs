import { describe, it, expect } from "vitest";
import {
  SOURCE_LIMIT,
  TEST_LIMIT,
  isTestFile,
  limitFor,
  countLines,
  exceedsCap,
} from "./check-file-length.mjs";

describe("isTestFile", () => {
  it("classifies spec/test extensions as test files", () => {
    expect(isTestFile("src/engine/runner.spec.ts")).toBe(true);
    expect(isTestFile("src/ui/Button.spec.tsx")).toBe(true);
    expect(isTestFile("src/db/foo.test.ts")).toBe(true);
  });

  it("classifies files under a *-tests/ directory as test files", () => {
    expect(isTestFile("src/db/adapters/hostedFirestore-tests/crud.ts")).toBe(
      true,
    );
  });

  it("classifies plain source files as non-test", () => {
    expect(isTestFile("src/engine/runner.ts")).toBe(false);
    expect(isTestFile("src/ui/Button.tsx")).toBe(false);
  });
});

describe("limitFor", () => {
  it("gives source files the source cap", () => {
    expect(limitFor("src/engine/runner.ts")).toEqual({
      limit: SOURCE_LIMIT,
      kind: "source",
    });
  });

  it("gives test files the larger test cap", () => {
    expect(limitFor("src/engine/runner.spec.ts")).toEqual({
      limit: TEST_LIMIT,
      kind: "test",
    });
  });
});

describe("countLines", () => {
  it("counts newline characters like wc -l", () => {
    expect(countLines("a\nb\nc\n")).toBe(3);
    expect(countLines("a\nb")).toBe(1);
    expect(countLines("")).toBe(0);
  });
});

describe("exceedsCap", () => {
  it("fails at or above the cap and passes below it", () => {
    expect(exceedsCap(SOURCE_LIMIT - 1, SOURCE_LIMIT)).toBe(false);
    expect(exceedsCap(SOURCE_LIMIT, SOURCE_LIMIT)).toBe(true);
    expect(exceedsCap(TEST_LIMIT - 1, TEST_LIMIT)).toBe(false);
    expect(exceedsCap(TEST_LIMIT, TEST_LIMIT)).toBe(true);
  });
});
