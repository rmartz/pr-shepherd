#!/usr/bin/env node
// Enforce the agent directive-file convention across the repository:
//
//   1. All directives live in AGENTS.md — the single source of truth for a
//      directory's agent instructions.
//   2. Every AGENTS.md has a companion CLAUDE.md in the same directory, and
//      every CLAUDE.md has a companion AGENTS.md in the same directory.
//   3. Every CLAUDE.md is a bare wrapper whose only content is the Claude Code
//      import line `@AGENTS.md` — a real file (not a directory or symlink), with
//      no directives and no other text.
//
//   check-agents-md.mjs        # walk the tree, pair the files, report violations
//
// A full copy of AGENTS.md kept in CLAUDE.md invites silent drift; reducing
// CLAUDE.md to a bare `@AGENTS.md` import keeps directives authored once, with
// exactly one place to edit and no copy to fall out of sync.
//
// Exit 0 = the whole tree is compliant; exit 1 = one or more violations
// (printed per file).

import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";

// The sole content a CLAUDE.md wrapper may carry (blank lines aside).
export const IMPORT_LINE = "@AGENTS.md";

// Directories that never hold first-party directive files — vendored deps,
// build output, VCS internals, and the harness's own `.claude` / worktree dirs.
const SKIP_DIRS = new Set([
  ".claude",
  ".git",
  ".git-worktrees",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "storybook-static",
]);

// Returns an error string when `content` is not a bare `@AGENTS.md` wrapper, or
// undefined when it is. Blank lines are ignored; any other non-blank line — a
// heading, a directive, a second import — is a violation.
export function wrapperContentError(content) {
  const meaningful = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (meaningful.length === 1 && meaningful[0] === IMPORT_LINE) {
    return undefined;
  }
  return `CLAUDE.md must contain only the bare import line \`${IMPORT_LINE}\`, but found: ${JSON.stringify(meaningful)}`;
}

// Returns the pairing violations for one directory, given which directive files
// it holds. A pure function of the presence flags so the rule is unit-testable.
// The message leads with the offending file so the reporter can key `file=` off
// it.
export function pairingErrors({ hasAgents, hasClaude }) {
  const errors = [];
  if (hasAgents && !hasClaude) {
    errors.push(
      "AGENTS.md has no companion CLAUDE.md — add a CLAUDE.md containing only `@AGENTS.md`",
    );
  }
  if (hasClaude && !hasAgents) {
    errors.push(
      "CLAUDE.md has no companion AGENTS.md — directives must live in a sibling AGENTS.md",
    );
  }
  return errors;
}

// Recursively collect every directory that holds an AGENTS.md or CLAUDE.md. A
// symlinked CLAUDE.md is matched by name here (its dirent is neither file nor
// directory) so the symlink check downstream still sees it.
function collectDirs(dir, found) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectDirs(join(dir, entry.name), found);
    } else if (entry.name === "AGENTS.md" || entry.name === "CLAUDE.md") {
      found.add(dir);
    }
  }
  return found;
}

function hasFile(dir, name) {
  try {
    lstatSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

const IN_CI = process.env["GITHUB_ACTIONS"] === "true";

function report(file, message) {
  if (IN_CI) {
    console.log(`::error file=${file}::${message}`);
  } else {
    console.error(`error: ${file}: ${message}`);
  }
}

function main() {
  let failed = false;
  for (const dir of collectDirs(".", new Set())) {
    const rel = relative(".", dir) || ".";
    const hasAgents = hasFile(dir, "AGENTS.md");
    const hasClaude = hasFile(dir, "CLAUDE.md");

    for (const message of pairingErrors({ hasAgents, hasClaude })) {
      report(
        join(rel, message.startsWith("AGENTS.md") ? "AGENTS.md" : "CLAUDE.md"),
        message,
      );
      failed = true;
    }

    if (hasClaude) {
      const claudePath = join(dir, "CLAUDE.md");
      const relClaude = join(rel, "CLAUDE.md");
      const stat = lstatSync(claudePath);
      if (stat.isSymbolicLink()) {
        report(
          relClaude,
          "CLAUDE.md is a symlink; it must be a real file containing only `@AGENTS.md`",
        );
        failed = true;
      } else if (!stat.isFile()) {
        report(
          relClaude,
          "CLAUDE.md is not a regular file (e.g. a directory); it must be a real file containing only `@AGENTS.md`",
        );
        failed = true;
      } else {
        const error = wrapperContentError(readFileSync(claudePath, "utf8"));
        if (error) {
          report(relClaude, error);
          failed = true;
        }
      }
    }
  }

  if (failed) {
    console.error(
      "\nAgent directive-file convention: directives live in AGENTS.md, every " +
        "AGENTS.md is paired with a CLAUDE.md, and every CLAUDE.md contains only " +
        `the bare \`${IMPORT_LINE}\` import. See the "Agent Directive Files" ` +
        "section of AGENTS.md.",
    );
    return 1;
  }
  console.log("All AGENTS.md / CLAUDE.md pairs are compliant.");
  return 0;
}

if (process.argv[1]?.endsWith("check-agents-md.mjs")) {
  process.exit(main());
}
