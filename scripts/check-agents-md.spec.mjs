import { describe, it, expect } from "vitest";
import {
  IMPORT_LINE,
  pairingErrors,
  wrapperContentError,
} from "./check-agents-md.mjs";

describe("wrapperContentError accepts a bare @AGENTS.md wrapper", () => {
  it("passes the exact import line", () => {
    expect(wrapperContentError(`${IMPORT_LINE}\n`)).toBeUndefined();
  });

  it("ignores surrounding blank lines", () => {
    expect(wrapperContentError(`\n${IMPORT_LINE}\n\n`)).toBeUndefined();
  });
});

describe("wrapperContentError flags a non-bare CLAUDE.md", () => {
  it("flags directive content", () => {
    const error = wrapperContentError(
      "# Code Standards\n\n- Always use pnpm.\n",
    );
    expect(error).toMatch(new RegExp(IMPORT_LINE));
  });

  it("flags the import line plus extra text", () => {
    expect(wrapperContentError(`${IMPORT_LINE}\n\nExtra note.\n`)).toMatch(
      /only the bare import line/,
    );
  });

  it("flags an empty file", () => {
    expect(wrapperContentError("\n\n")).toMatch(/only the bare import line/);
  });

  it("flags a different import target", () => {
    expect(wrapperContentError("@OTHER.md\n")).toMatch(
      /only the bare import line/,
    );
  });
});

describe("pairingErrors requires AGENTS.md and CLAUDE.md to be paired", () => {
  it("passes a fully paired directory", () => {
    expect(pairingErrors({ hasAgents: true, hasClaude: true })).toEqual([]);
  });

  it("passes a directory with neither file", () => {
    expect(pairingErrors({ hasAgents: false, hasClaude: false })).toEqual([]);
  });

  it("flags an AGENTS.md with no companion CLAUDE.md", () => {
    const errors = pairingErrors({ hasAgents: true, hasClaude: false });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/no companion CLAUDE\.md/);
  });

  it("flags a CLAUDE.md with no companion AGENTS.md", () => {
    const errors = pairingErrors({ hasAgents: false, hasClaude: true });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/no companion AGENTS\.md/);
  });
});
