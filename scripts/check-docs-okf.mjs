#!/usr/bin/env node
// Validate that every page under docs/ carries OKF (Open Knowledge Format)
// frontmatter, so the docs tree stays an agent-retrievable knowledge graph.
//
// OKF requires only a `type` key in each page's YAML frontmatter. We constrain
// `type` to the project's vocabulary (see ALLOWED_TYPES) so the graph is
// navigable by category. Other keys (title, description, resource, tags) are
// recommended but optional, mirroring the spec.
//
//   check-docs-okf.mjs            # validate ./docs, exit non-zero on any error
//
// Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";

// The canonical `type` vocabulary for pr-shepherd docs (alphabetical). Reserved
// `index.md` files carry no `type` (see validatePage) — they are exempt from
// this vocabulary per OKF §8, so `Index` is intentionally absent.
export const ALLOWED_TYPES = [
  "Adapter", // a src/db data adapter
  "Design", // a design / goal-state document
  "Log", // the OKF dated change history (docs/log.md)
  "Reference", // general reference (local-development, topology, …)
  "StepExecutor", // a src/steps/* executor
  "Subsystem", // an src/engine/* module
  "Workflow", // a workflows/*.yaml definition
];

// OKF §8: an index file carries no frontmatter, with one exception — any
// `index.md` MAY carry an `okf_version` key.
const INDEX_ALLOWED_KEYS = ["okf_version"];

// Extract and parse a page's leading `---\n…\n---` YAML frontmatter block.
// Returns the parsed object when a valid object block is present, null when a
// block is present but parses to a non-object (empty or scalar), or undefined
// when no frontmatter delimiter is found at all.
export function parseFrontmatter(content) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (match === null) return undefined;
  const parsed = parse(match[1]);
  return parsed !== null && typeof parsed === "object" ? parsed : null;
}

// Returns a list of human-readable problems for one page (empty = valid).
export function validatePage(path, content) {
  const frontmatter = parseFrontmatter(content);

  // Reserved `index.md` files (OKF §8/§11) are exempt from the `type` rule:
  // they carry no frontmatter, except an optional `okf_version`.
  if (basename(path) === "index.md") {
    if (frontmatter === undefined) return [];
    if (frontmatter === null) {
      return [
        `${path}: index files carry no frontmatter beyond \`okf_version\` (found: empty or non-object block)`,
      ];
    }
    const disallowed = Object.keys(frontmatter).filter(
      (key) => !INDEX_ALLOWED_KEYS.includes(key),
    );
    if (disallowed.length > 0) {
      return [
        `${path}: index files carry no frontmatter beyond \`okf_version\` (found: ${disallowed.join(", ")})`,
      ];
    }
    return [];
  }

  if (frontmatter === undefined || frontmatter === null) {
    return [`${path}: missing OKF frontmatter (a leading --- … --- block)`];
  }
  const { type } = frontmatter;
  if (typeof type !== "string" || type.length === 0) {
    return [`${path}: frontmatter is missing the required \`type\` key`];
  }
  if (!ALLOWED_TYPES.includes(type)) {
    return [
      `${path}: type "${type}" is not in the allowed vocabulary (${ALLOWED_TYPES.join(", ")})`,
    ];
  }
  return [];
}

function markdownFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map((entry) => entry.toString())
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => join(dir, entry));
}

function main() {
  const errors = markdownFiles("docs").flatMap((path) =>
    validatePage(path, readFileSync(path, "utf8")),
  );
  if (errors.length > 0) {
    console.error("OKF docs validation failed:\n" + errors.join("\n"));
    return 1;
  }
  return 0;
}

if (process.argv[1]?.endsWith("check-docs-okf.mjs")) {
  process.exit(main());
}
