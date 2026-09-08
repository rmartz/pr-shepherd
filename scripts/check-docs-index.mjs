#!/usr/bin/env node
// Validate that the docs/ tree is a navigable OKF knowledge graph: starting at
// docs/index.md and following markdown links — traversing only index.md files
// onward — every .md page under docs/ must be reachable. This enforces two rules
// at once:
//
//   1. Every page is listed in *an* index.md (otherwise it is unreachable).
//   2. Every subdirectory's index.md is itself reachable from a parent index.md
//      (otherwise the pages reachable only through it drop off the graph).
//
// so a reader can always navigate docs/index.md -> …/index.md -> …/page.md. A
// page that no index links to (directly or transitively) is an orphan.
//
//   check-docs-index.mjs          # validate ./docs, exit non-zero on any orphan
//
// Exit 0 = every page is reachable; exit 1 = one or more orphaned pages.

import { readdirSync, readFileSync } from "node:fs";
import { sep, posix } from "node:path";

const ROOT_INDEX = "docs/index.md";

// Extract the target of every inline markdown link `[label](target)` in `content`.
// Reference-style and bare-URL links are out of scope — an index lists pages with
// inline links.
export function extractLinkTargets(content) {
  const targets = [];
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    targets.push(match[1].trim());
  }
  return targets;
}

// Resolve a raw markdown link target found in the index file at `fromDir` to a
// repo-relative docs path, or undefined when it is not a link to a local .md page
// (external URL, anchor-only, or a non-markdown resource). Strips an optional
// `"title"` suffix and a `#anchor` fragment before resolving.
export function resolveDocTarget(fromDir, target) {
  const withoutTitle = target.trim().split(/\s+/)[0];
  const path = withoutTitle.split("#")[0];
  if (path.length === 0) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return undefined; // scheme: http:, mailto:, …
  if (!path.endsWith(".md")) return undefined;
  return posix.normalize(posix.join(fromDir, path));
}

// Given the set of docs pages, the root index, and a content reader, return the
// pages that are not reachable from the root index by walking index-to-index
// links. A pure function of its inputs so the traversal is unit-testable.
export function findOrphans({ files, rootIndex, readContent }) {
  const fileSet = new Set(files);
  const reachable = new Set();
  const queue = [];
  const enqueue = (file) => {
    if (reachable.has(file)) return;
    reachable.add(file);
    // Only index.md pages carry the tree onward; leaves are terminal.
    if (posix.basename(file) === "index.md") queue.push(file);
  };

  enqueue(rootIndex);
  while (queue.length > 0) {
    const index = queue.shift();
    const dir = posix.dirname(index);
    for (const target of extractLinkTargets(readContent(index))) {
      const resolved = resolveDocTarget(dir, target);
      if (resolved !== undefined && fileSet.has(resolved)) enqueue(resolved);
    }
  }

  return [...fileSet].filter((file) => !reachable.has(file)).sort();
}

function collectDocFiles() {
  return readdirSync("docs", { recursive: true })
    .map((entry) => entry.toString())
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => posix.join("docs", entry.split(sep).join("/")));
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
  const files = collectDocFiles();
  if (!files.includes(ROOT_INDEX)) {
    report(
      ROOT_INDEX,
      `${ROOT_INDEX} is missing — it is the root of the docs graph`,
    );
    return 1;
  }

  const orphans = findOrphans({
    files,
    rootIndex: ROOT_INDEX,
    readContent: (file) => readFileSync(file, "utf8"),
  });
  if (orphans.length === 0) {
    console.log(
      `All ${files.length} docs pages are reachable from ${ROOT_INDEX}.`,
    );
    return 0;
  }

  for (const orphan of orphans) {
    report(orphan, `not reachable from ${ROOT_INDEX} — list it in an index.md`);
  }
  console.error(
    `\n${orphans.length} orphaned docs page(s). Link each from an index.md so a reader can ` +
      `navigate ${ROOT_INDEX} -> …/index.md -> …/page.md; a subdirectory's index.md must itself ` +
      `be linked from a parent index.md.`,
  );
  return 1;
}

if (process.argv[1]?.endsWith("check-docs-index.mjs")) {
  process.exit(main());
}
