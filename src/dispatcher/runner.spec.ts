import { describe, expect, it } from "vitest";
import { buildClaudeArgv } from "./runner";

describe("buildClaudeArgv", () => {
  it("terminates options before the prompt", () => {
    expect(buildClaudeArgv(["--allowedTools", "Bash"], "/review 7")).toEqual([
      "-p",
      "--allowedTools",
      "Bash",
      "--",
      "/review 7",
    ]);
  });
});
