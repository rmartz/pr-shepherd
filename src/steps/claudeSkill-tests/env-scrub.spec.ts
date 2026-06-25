import { spawn } from "node:child_process";
import { describe, it, expect } from "vitest";
import { scrubGithubEnv } from "../claudeSkill";

describe("claudeSkillExecutor scrubs GitHub credentials from the subprocess env", () => {
  it("removes GITHUB_TOKEN / GH_TOKEN / *MCP*GITHUB* (verified via a real printenv child)", () => {
    const env = scrubGithubEnv({
      GITHUB_TOKEN: "secret-1",
      GH_TOKEN: "secret-2",
      GITHUB_MCP_PAT: "secret-3",
      KEEP_ME: "ok",
      PATH: process.env["PATH"],
    });
    return new Promise<void>((resolve, reject) => {
      // tsc needs the repo-augmented NodeJS.ProcessEnv here (without it the
      // spawn overload resolves to `never`); the scrubbed value is a plain
      // string map.
      const child = spawn("printenv", [], {
        env: env as unknown as NodeJS.ProcessEnv,
      });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.on("error", reject);
      child.on("close", () => {
        try {
          expect(out).toContain("KEEP_ME=ok");
          expect(out).not.toContain("GITHUB_TOKEN=");
          expect(out).not.toContain("GH_TOKEN=");
          expect(out).not.toContain("GITHUB_MCP_PAT=");
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  });

  it("scrubGithubEnv drops the credential keys and keeps the rest", () => {
    const scrubbed = scrubGithubEnv({
      GITHUB_TOKEN: "x",
      GH_TOKEN: "y",
      MCP_GITHUB_SERVER_TOKEN: "z",
      HOME: "/home/me",
    });
    expect(scrubbed).toEqual({ HOME: "/home/me" });
  });
});
