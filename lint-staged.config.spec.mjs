import { describe, it, expect } from "vitest";
import { quoteArg, prettierCommands } from "./lint-staged.config.mjs";

describe("quoteArg shell-quotes a path safely", () => {
  it("wraps a path containing spaces in a single quoted token", () => {
    expect(quoteArg("src/my component.tsx")).toBe("'src/my component.tsx'");
  });

  it("escapes embedded single quotes so the path stays one token", () => {
    expect(quoteArg("src/it's a file.ts")).toBe(`'src/it'\\''s a file.ts'`);
  });

  it("quotes paths with shell-special characters", () => {
    expect(quoteArg("src/$(rm -rf x).ts")).toBe("'src/$(rm -rf x).ts'");
  });
});

describe("prettierCommands quotes every path before joining", () => {
  it("passes a space-containing path as a single quoted argument", () => {
    expect(prettierCommands(["src/my component.tsx"])).toEqual([
      "prettier --write 'src/my component.tsx'",
    ]);
  });

  it("quotes each of multiple paths independently", () => {
    expect(prettierCommands(["a b.ts", "c.ts"])).toEqual([
      "prettier --write 'a b.ts' 'c.ts'",
    ]);
  });

  it("excludes lockfiles from the formatted set", () => {
    expect(prettierCommands(["pnpm-lock.yaml", "src/app.ts"])).toEqual([
      "prettier --write 'src/app.ts'",
    ]);
  });

  it("returns no command when every path is a lockfile", () => {
    expect(prettierCommands(["pnpm-lock.yaml", "yarn.lock"])).toEqual([]);
  });
});
