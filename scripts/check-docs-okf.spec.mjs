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

  it("returns null when a frontmatter block is present but parses to a non-object (empty block)", () => {
    expect(parseFrontmatter("---\n\n---\n\n# Foo\n")).toBeNull();
  });

  it("returns null when a frontmatter block is present but parses to a non-object (scalar)", () => {
    expect(parseFrontmatter("---\nhello\n---\n\n# Foo\n")).toBeNull();
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

  it("drops the dead `Index` type — index files carry no type (OKF §8)", () => {
    expect(ALLOWED_TYPES).not.toContain("Index");
  });
});

describe("validatePage exempts the reserved index.md from the type rule (OKF §8/§11)", () => {
  it("accepts an index file with no frontmatter at all", () => {
    expect(validatePage("docs/index.md", "# Docs\n")).toEqual([]);
  });

  it("accepts an index file carrying only okf_version", () => {
    const content = '---\nokf_version: "0.2"\n---\n\n# Docs\n';
    expect(validatePage("docs/index.md", content)).toEqual([]);
  });

  it("accepts a nested subdirectory index.md, not just the root", () => {
    const content = '---\nokf_version: "0.2"\n---\n';
    expect(validatePage("docs/subsystems/index.md", content)).toEqual([]);
  });

  it("flags an index file carrying frontmatter beyond okf_version", () => {
    const content = "---\ntype: Index\ntitle: Docs\n---\n";
    const errors = validatePage("docs/index.md", content);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("okf_version");
  });

  it("flags an index file with an empty frontmatter block", () => {
    const errors = validatePage("docs/index.md", "---\n\n---\n\n# Docs\n");
    expect(errors).toHaveLength(1);
  });

  it("flags an index file with a scalar frontmatter block", () => {
    const errors = validatePage("docs/index.md", "---\nhello\n---\n\n# Docs\n");
    expect(errors).toHaveLength(1);
  });
});
