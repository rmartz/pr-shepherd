#!/usr/bin/env node
// Enforce the file-length hard cap on changed TypeScript files.
//
// Hard cap (NOT a ratchet): a changed/staged `.ts`/`.tsx` file fails when its
// line count is at or above the cap, regardless of whether the change shrank
// it. Caps are +100% of the recommended limit from CLAUDE.md (2x recommended):
//   Source files: recommended 200 -> cap 400
//   Test files:   recommended 300 -> cap 600
//
// Single source of truth for both enforcement points:
//   check-file-length.mjs --staged       # staged blobs (the .husky/pre-commit hook)
//   check-file-length.mjs --base <ref>   # working tree vs <ref> (CI; <ref> is the
//                                         # PR merge-base, passed by file-length.yml)
//
// Only `.ts`/`.tsx` files are checked; deletions are skipped. Bypass: a commit
// made with `git commit --no-verify` skips the local hook — CI is the backstop.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SOURCE_LIMIT = 400;
export const TEST_LIMIT = 600;

// GitHub Actions sets this; used to emit `::error` annotations that surface on
// the PR's Files-changed view. Plain stderr everywhere else.
const IN_CI = process.env["GITHUB_ACTIONS"] === "true";

// A file is a "test" if it carries a spec/test extension or lives under a
// `*-tests/` directory — matching file-length.yml's globs exactly.
export function isTestFile(path) {
  if (/\.(spec|test)\.tsx?$/.test(path)) return true;
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) => segment.endsWith("-tests"));
}

export function limitFor(path) {
  return isTestFile(path)
    ? { limit: TEST_LIMIT, kind: "test" }
    : { limit: SOURCE_LIMIT, kind: "source" };
}

// Mirrors `wc -l`: the number of newline characters.
export function countLines(content) {
  let count = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "\n") count += 1;
  }
  return count;
}

export function exceedsCap(lines, limit) {
  return lines >= limit;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function isTypeScript(path) {
  return path.endsWith(".ts") || path.endsWith(".tsx");
}

// Returns the list of changed `.ts`/`.tsx` files, plus a reader yielding each
// file's content (or undefined to skip — e.g. a deletion).
function collect(mode, base) {
  if (mode === "staged") {
    const out = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
    const files = out.split("\n").filter(isTypeScript);
    return {
      files,
      read: (path) => {
        try {
          return git(["show", `:${path}`]);
        } catch {
          return undefined;
        }
      },
    };
  }
  const out = git(["diff", "--name-only", base, "HEAD"]);
  const files = out.split("\n").filter(isTypeScript);
  return {
    files,
    read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
  };
}

function report(path, lines, kind, limit) {
  if (IN_CI) {
    console.log(
      `::error file=${path},title=File too long::${path} — ${lines} lines (${kind} limit: ${limit})`,
    );
  } else {
    console.error(`error: ${path} — ${lines} lines (${kind} limit: ${limit})`);
  }
}

function main(argv) {
  const staged = argv.includes("--staged");
  const baseIndex = argv.indexOf("--base");
  const base = baseIndex !== -1 ? argv[baseIndex + 1] : undefined;
  if (!staged && base === undefined) {
    console.error("usage: check-file-length.mjs (--staged | --base <ref>)");
    return 2;
  }

  const { files, read } = collect(staged ? "staged" : "base", base);
  let failed = false;
  for (const path of files) {
    const content = read(path);
    if (content === undefined) continue; // deletion or unreadable — skip
    const { limit, kind } = limitFor(path);
    const lines = countLines(content);
    if (exceedsCap(lines, limit)) {
      report(path, lines, kind, limit);
      failed = true;
    }
  }

  if (failed) {
    console.error(
      "\nOne or more files exceed the hard line-count cap (2x the recommended limit).\n" +
        `  Source files: recommended 200, fails at ${SOURCE_LIMIT}+\n` +
        `  Test files:   recommended 300, fails at ${TEST_LIMIT}+\n` +
        "Split large files by logical concern before committing.",
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
