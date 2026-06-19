import { describe, it, expect } from "vitest";
import {
  ALLOWED_TYPES,
  parseFrontmatter,
  validatePage,
} from "./check-docs-okf.mjs";

describe("parseFrontmatter extracts a page's YAML frontmatter", () => {
  it("returns the parsed object for a valid leading block", () => {
    const content = "---\ntype: Subsystem\ntitle: Foo\n---\n\n# Foo\n";
    expect(parseFrontmatter(content)).toEqual({
      type: "Subsystem",
      title: "Foo",
    });
  });

  it("returns undefined when there is no frontmatter", () => {
    expect(parseFrontmatter("# Foo\n\nNo frontmatter here.\n")).toBeUndefined();
  });
});

describe("validatePage enforces OKF frontmatter with an allowed type", () => {
  it("accepts a page whose type is in the vocabulary", () => {
    const content = "---\ntype: StepExecutor\ntitle: claude_skill\n---\n";
    expect(validatePage("docs/steps/claude-skill.md", content)).toEqual([]);
  });

  it("flags a page with no frontmatter", () => {
    expect(validatePage("docs/x.md", "# X\n")).toHaveLength(1);
  });

  it("flags a page whose frontmatter omits type", () => {
    const content = "---\ntitle: No type here\n---\n";
    expect(validatePage("docs/x.md", content)).toHaveLength(1);
  });

  it("flags a page whose type is outside the vocabulary", () => {
    const content = "---\ntype: Bogus\n---\n";
    const errors = validatePage("docs/x.md", content);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not in the allowed vocabulary");
  });

  it("keeps the type vocabulary alphabetized", () => {
    expect(ALLOWED_TYPES).toEqual([...ALLOWED_TYPES].sort());
  });
});
