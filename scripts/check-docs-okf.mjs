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
import { join } from "node:path";
import { parse } from "yaml";

// The canonical `type` vocabulary for pr-shepherd docs (alphabetical).
export const ALLOWED_TYPES = [
  "Adapter", // a src/db data adapter
  "Design", // a design / goal-state document
  "Index", // the OKF directory listing (docs/index.md)
  "Log", // the OKF dated change history (docs/log.md)
  "Reference", // general reference (local-development, topology, …)
  "StepExecutor", // a src/steps/* executor
  "Subsystem", // an src/engine/* module
  "Workflow", // a workflows/*.yaml definition
];

// Extract and parse a page's leading `---\n…\n---` YAML frontmatter block.
// Returns the parsed object, or undefined when no frontmatter is present.
export function parseFrontmatter(content) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (match === null) return undefined;
  const parsed = parse(match[1]);
  return parsed !== null && typeof parsed === "object" ? parsed : undefined;
}

// Returns a list of human-readable problems for one page (empty = valid).
export function validatePage(path, content) {
  const frontmatter = parseFrontmatter(content);
  if (frontmatter === undefined) {
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
