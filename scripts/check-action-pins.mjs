#!/usr/bin/env node
// Enforce that every third-party GitHub Action is pinned to a full commit SHA
// with a version comment.
//
// Hardening against a tag-mutation / force-push supply-chain attack (#323): a
// mutable tag (`actions/checkout@v7`) can be force-moved to a malicious commit,
// but an immutable 40-char SHA cannot. The trailing `# vX.Y.Z` comment is
// required so Dependabot can read the current version and keep the SHA current.
//
//   check-action-pins.mjs        # scan .github for tag-pinned / comment-less uses
//
// A `uses:` is exempt when it is a local reference (`./…`, `../…`) — no
// supply-chain surface — or a `docker://` image. Everything else (owner/repo,
// including cross-repo reusable workflows) must be SHA-pinned with a comment.
//
// Exit 0 = all pinned; exit 1 = one or more violations (printed with file:line).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SHA_RE = /^[0-9a-f]{40}$/;

// Returns [{ line, uses, reason }] for every third-party `uses:` in `text` that
// is not pinned to a full commit SHA with a version comment. 1-based lines.
export function findPinViolations(text) {
  const lines = text.split("\n");
  const violations = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^\s*(?:-\s+)?uses:\s*(.+?)\s*$/);
    if (match === null) continue;

    let value = match[1];
    let comment;
    const hashIndex = value.indexOf("#");
    if (hashIndex !== -1) {
      comment = value.slice(hashIndex + 1).trim();
      value = value.slice(0, hashIndex).trim();
    }
    value = value.replace(/^["']|["']$/g, "");

    // Local and Docker references carry no tag-mutation surface — exempt.
    if (value.startsWith("./") || value.startsWith("../")) continue;
    if (value.startsWith("docker://")) continue;

    const atIndex = value.lastIndexOf("@");
    if (atIndex === -1) {
      violations.push({
        line: i + 1,
        uses: value,
        reason:
          "not pinned — add a full 40-char commit SHA and a version comment",
      });
      continue;
    }

    const ref = value.slice(atIndex + 1);
    if (!SHA_RE.test(ref)) {
      violations.push({
        line: i + 1,
        uses: value,
        reason: `not SHA-pinned — "${ref}" is not a full 40-char commit SHA`,
      });
      continue;
    }
    if (comment === undefined || !/\d/.test(comment)) {
      violations.push({
        line: i + 1,
        uses: value,
        reason:
          'SHA pin needs a version comment (e.g. "# v1.2.3") so Dependabot can update it',
      });
    }
  }
  return violations;
}

// Recursively collect every YAML file under `dir`.
function walkYaml(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found; // directory absent — nothing to scan
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walkYaml(full));
    } else if (/\.ya?ml$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

const IN_CI = process.env["GITHUB_ACTIONS"] === "true";

function report(file, violation) {
  if (IN_CI) {
    console.log(
      `::error file=${file},line=${violation.line}::${violation.uses} — ${violation.reason}`,
    );
  } else {
    console.error(
      `error: ${file}:${violation.line} — ${violation.uses}: ${violation.reason}`,
    );
  }
}

function main() {
  let failed = false;
  for (const file of walkYaml(".github")) {
    for (const violation of findPinViolations(readFileSync(file, "utf8"))) {
      report(file, violation);
      failed = true;
    }
  }
  if (failed) {
    console.error(
      "\nThird-party GitHub Actions must be pinned to a full commit SHA with a " +
        "`# vX.Y.Z` comment — immutable against tag-mutation attacks, and the " +
        "comment lets Dependabot keep the SHA current. See #323.",
    );
    return 1;
  }
  return 0;
}

if (process.argv[1]?.endsWith("check-action-pins.mjs")) {
  process.exit(main());
}
