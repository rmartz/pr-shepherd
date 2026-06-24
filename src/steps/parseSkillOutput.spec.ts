import { describe, it, expect } from "vitest";
import { parseSkillOutput, SkillOutputParseError } from "./parseSkillOutput";

// ---------------------------------------------------------------------------
// Tests for parseSkillOutput — the robust stdout → structured-output parser
// (#137). Covers the clean path, preamble/noise tolerance, embedded-span
// recovery, the empty-output no-result case, and the loud parse failure.
// ---------------------------------------------------------------------------

describe("parseSkillOutput parses clean JSON-object stdout", () => {
  it("returns the object when stdout is a single JSON object", () => {
    expect(parseSkillOutput('{"verdict":"approved","score":7}')).toEqual({
      verdict: "approved",
      score: 7,
    });
  });

  it("ignores surrounding whitespace and newlines", () => {
    expect(parseSkillOutput('\n  {"ok":true}\n  ')).toEqual({ ok: true });
  });
});

describe("parseSkillOutput tolerates CLI preamble before the JSON", () => {
  it("recovers the final JSON-object line after progress lines", () => {
    const stdout = [
      "Loading skill /review...",
      "Analyzing diff (3 files)...",
      '{"verdict":"changes_requested","comments":2}',
    ].join("\n");
    expect(parseSkillOutput(stdout)).toEqual({
      verdict: "changes_requested",
      comments: 2,
    });
  });

  it("picks the last JSON-object line when several are present", () => {
    const stdout = ['{"step":"start"}', '{"verdict":"approved"}'].join("\n");
    expect(parseSkillOutput(stdout)).toEqual({ verdict: "approved" });
  });

  it("recovers a JSON object embedded after preamble on the same line", () => {
    expect(parseSkillOutput('done -> {"verdict":"approved"}')).toEqual({
      verdict: "approved",
    });
  });

  it("does not let braces inside string values truncate the span", () => {
    expect(
      parseSkillOutput('log: {"body":"see commit {abc} for details"}'),
    ).toEqual({ body: "see commit {abc} for details" });
  });
});

describe("parseSkillOutput treats empty output as no structured result", () => {
  it("returns an empty object for empty stdout", () => {
    expect(parseSkillOutput("")).toEqual({});
  });

  it("returns an empty object for whitespace-only stdout", () => {
    expect(parseSkillOutput("   \n  \t ")).toEqual({});
  });
});

describe("parseSkillOutput throws loudly when no JSON object is present", () => {
  it("throws SkillOutputParseError for plain non-JSON text", () => {
    expect(() => parseSkillOutput("just some progress text")).toThrow(
      SkillOutputParseError,
    );
  });

  it("throws for a bare JSON array (not an object)", () => {
    expect(() => parseSkillOutput("[1,2,3]")).toThrow(SkillOutputParseError);
  });

  it("throws for a bare JSON primitive", () => {
    expect(() => parseSkillOutput('"approved"')).toThrow(SkillOutputParseError);
  });

  it("preserves the raw output and a truncated preview on the error", () => {
    const stdout = "x".repeat(300);
    try {
      parseSkillOutput(stdout);
      expect.unreachable("expected parseSkillOutput to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SkillOutputParseError);
      const parseErr = err as SkillOutputParseError;
      expect(parseErr.rawOutput).toBe(stdout);
      expect(parseErr.message).toContain("x".repeat(200));
      expect(parseErr.message).not.toContain("x".repeat(201));
    }
  });
});
