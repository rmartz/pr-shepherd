#!/usr/bin/env node
// Block commits that leave Git merge-conflict markers in staged files.
//
// A conflict resolution can leave markers behind; prettier then reflows them
// (a `>>>>>>>` becomes a nested blockquote, `=======` a setext heading) and
// the corrupted markers can no longer be matched — so catch them at commit
// time, before lint-staged's formatter ever runs.
//
//   check-conflict-markers.mjs --staged    # scan staged blobs (the pre-commit hook)
//
// Detection (full-triple rule, no doc special-casing): an **angle** marker —
// a line starting with seven `<` or seven `>` — is unambiguous and flagged
// anywhere. The separator (`=======`) and diff3 base (`|||||||`) lines are
// reported too, but only in a file that already has an angle marker, so a
// Markdown setext underline or `=======` divider is never a false positive.
//
// Bypass: `git commit --no-verify` (git-native), or ALLOW_CONFLICT_MARKERS=1.

import { execFileSync } from "node:child_process";

// Angle markers: unambiguous, flagged anywhere. Seven chars, line start,
// followed by whitespace or end of line.
const ANGLE_RE = /^(<<<<<<<|>>>>>>>)(\s|$)/;
// Separator / diff3-base: only a conflict marker when an angle marker is also
// present in the same file.
const MID_RE = /^(=======|\|\|\|\|\|\|\|)(\s|$)/;

// Returns [{ line, text }] for every conflict-marker line, 1-based. Empty when
// the text has no angle marker — separator/base lines alone do not count.
export function findConflictMarkers(text) {
  const lines = text.split("\n");
  const angles = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (ANGLE_RE.test(lines[i])) angles.push({ line: i + 1, text: lines[i] });
  }
  if (angles.length === 0) return [];
  const mids = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (MID_RE.test(lines[i])) mids.push({ line: i + 1, text: lines[i] });
  }
  return [...angles, ...mids].sort((a, b) => a.line - b.line);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function stagedFiles() {
  return git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    .split("\n")
    .filter((path) => path.length > 0);
}

function stagedContent(path) {
  try {
    return git(["show", `:${path}`]);
  } catch {
    return undefined; // binary / unreadable — nothing to scan
  }
}

function main(argv) {
  if (!argv.includes("--staged")) {
    console.error("usage: check-conflict-markers.mjs --staged");
    return 2;
  }
  if (process.env["ALLOW_CONFLICT_MARKERS"] === "1") return 0;

  let failed = false;
  for (const path of stagedFiles()) {
    const content = stagedContent(path);
    if (content === undefined) continue;
    const markers = findConflictMarkers(content);
    for (const { line } of markers) {
      console.error(`error: ${path}:${line} — Git conflict marker`);
      failed = true;
    }
  }
  if (failed) {
    console.error(
      "\nStaged files contain unresolved merge-conflict markers. Resolve them " +
        "before committing (or ALLOW_CONFLICT_MARKERS=1 / --no-verify to bypass).",
    );
    return 1;
  }
  return 0;
}

if (process.argv[1]?.endsWith("check-conflict-markers.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
