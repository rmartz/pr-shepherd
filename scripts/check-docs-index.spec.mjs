import { describe, it, expect } from "vitest";
import {
  extractLinkTargets,
  resolveDocTarget,
  findOrphans,
} from "./check-docs-index.mjs";

describe("extractLinkTargets pulls inline markdown link targets", () => {
  it("extracts multiple targets in document order", () => {
    const content = "See [a](steps/a.md) and [b](sub/index.md).";
    expect(extractLinkTargets(content)).toEqual(["steps/a.md", "sub/index.md"]);
  });

  it("returns nothing when there are no links", () => {
    expect(extractLinkTargets("# Title\n\nProse only.\n")).toEqual([]);
  });
});

describe("resolveDocTarget resolves local .md links relative to the index dir", () => {
  it("resolves a child page", () => {
    expect(resolveDocTarget("docs", "steps/a.md")).toBe("docs/steps/a.md");
  });

  it("strips an anchor and a link title", () => {
    expect(resolveDocTarget("docs", 'steps/a.md#section "A title"')).toBe(
      "docs/steps/a.md",
    );
  });

  it("ignores external URLs and non-markdown targets", () => {
    expect(
      resolveDocTarget("docs", "https://example.com/x.md"),
    ).toBeUndefined();
    expect(resolveDocTarget("docs", "../src/foo.ts")).toBeUndefined();
  });
});

describe("findOrphans reports pages unreachable from the root index", () => {
  const rootIndex = "docs/index.md";

  it("passes a flat tree where the root index links every page", () => {
    const content = {
      "docs/index.md": "[a](steps/a.md) [b](steps/b.md)",
      "docs/steps/a.md": "leaf",
      "docs/steps/b.md": "leaf",
    };
    const orphans = findOrphans({
      files: Object.keys(content),
      rootIndex,
      readContent: (file) => content[file],
    });
    expect(orphans).toEqual([]);
  });

  it("flags a page no index links to", () => {
    const content = {
      "docs/index.md": "[a](steps/a.md)",
      "docs/steps/a.md": "leaf",
      "docs/steps/orphan.md": "leaf",
    };
    const orphans = findOrphans({
      files: Object.keys(content),
      rootIndex,
      readContent: (file) => content[file],
    });
    expect(orphans).toEqual(["docs/steps/orphan.md"]);
  });

  it("navigates root index -> subdirectory index -> leaf", () => {
    const content = {
      "docs/index.md": "[sub](sub/index.md)",
      "docs/sub/index.md": "[feature](feature.md)",
      "docs/sub/feature.md": "leaf",
    };
    const orphans = findOrphans({
      files: Object.keys(content),
      rootIndex,
      readContent: (file) => content[file],
    });
    expect(orphans).toEqual([]);
  });

  it("flags a subdirectory index (and its pages) that no parent index links", () => {
    const content = {
      "docs/index.md": "no links here",
      "docs/sub/index.md": "[feature](feature.md)",
      "docs/sub/feature.md": "leaf",
    };
    const orphans = findOrphans({
      files: Object.keys(content),
      rootIndex,
      readContent: (file) => content[file],
    });
    expect(orphans).toEqual(["docs/sub/feature.md", "docs/sub/index.md"]);
  });
});
