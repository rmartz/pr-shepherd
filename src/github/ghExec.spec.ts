import { describe, it, expect } from "vitest";
import { isRateLimitResult } from "./ghExec";

// The rate-limit classifier is the load-bearing bit of ghExec: it decides
// whether a failed `gh` call becomes a GithubRateLimitError (retried) or a hard
// error (surfaced). `defaultGhExec` itself spawns a real subprocess and is not
// unit-tested here.

describe("isRateLimitResult", () => {
  it("flags a non-zero exit whose stderr names a rate limit", () => {
    expect(
      isRateLimitResult({
        stdout: "",
        stderr: "API rate limit exceeded for user",
        exitCode: 1,
      }),
    ).toBe(true);
  });

  it("does not flag a successful result even if stdout mentions a limit", () => {
    expect(
      isRateLimitResult({
        stdout: '{"rate limit": "irrelevant"}',
        stderr: "",
        exitCode: 0,
      }),
    ).toBe(false);
  });

  it("does not flag a non-rate-limit failure", () => {
    expect(
      isRateLimitResult({
        stdout: "",
        stderr: "gh: Not Found (HTTP 404)",
        exitCode: 1,
      }),
    ).toBe(false);
  });
});
