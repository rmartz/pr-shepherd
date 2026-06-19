import { describe, it, expect } from "vitest";
import { findConflictMarkers } from "./check-conflict-markers.mjs";

describe("findConflictMarkers flags unresolved conflict markers (full-triple rule)", () => {
  it("flags a full conflict block", () => {
    const text = [
      "line a",
      "<<<<<<< HEAD",
      "ours",
      "=======",
      "theirs",
      ">>>>>>> branch",
      "line b",
    ].join("\n");
    const markers = findConflictMarkers(text);
    expect(markers.map((m) => m.line)).toEqual([2, 4, 6]);
  });

  it("flags an angle marker on its own", () => {
    expect(findConflictMarkers("a\n<<<<<<< HEAD\nb\n")).toEqual([
      { line: 2, text: "<<<<<<< HEAD" },
    ]);
  });

  it("does NOT flag a lone ======= divider with no angle marker (Markdown safe)", () => {
    const text = "# Title\n=======\n\nSome prose under a setext heading.\n";
    expect(findConflictMarkers(text)).toEqual([]);
  });

  it("does NOT flag === dividers shorter than seven characters", () => {
    expect(findConflictMarkers("a\n=====\nb\n")).toEqual([]);
  });

  it("returns empty for clean content", () => {
    expect(findConflictMarkers("just\nnormal\nlines\n")).toEqual([]);
  });
});
