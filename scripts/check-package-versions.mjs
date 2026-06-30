#!/usr/bin/env node
// Enforce full major.minor.patch pins in package.json (see AGENTS.md "Package
// Manager"). Every direct dependency's version range must carry a complete
// `major.minor.patch` base — keeping any `^`/`~` operator — so a Dependabot
// minor/patch bump always lands as a visible `package.json` diff rather than a
// lockfile-only change. A truncated pin like `"prettier": "^3"` lets a silent
// bump through (cf. rmartz/trip-split#114).
//
// Only registry semver ranges are enforced: a spec that starts with an optional
// `^`/`~` followed by a digit. Non-registry / non-simple specifiers
// (`workspace:`, `catalog:`, `link:`, `file:`, git/URL, `*`, `latest`, or
// compound ranges with spaces / `||` / comparison operators) are skipped — they
// are not the manifest pins this rule governs.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIELDS = ["dependencies", "devDependencies"];
const FULL_PIN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

// A spec we should enforce: optional ^/~ then a digit, and not a compound range
// or a non-registry specifier (those carry a space, `||`, `:`, or `/`).
function isEnforceable(spec) {
  return (
    /^[\^~]?\d/.test(spec) && !/[\s|:/]/.test(spec) && !spec.includes("||")
  );
}

function hasFullBase(spec) {
  return FULL_PIN.test(spec.replace(/^[\^~]/, ""));
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const offenders = [];

for (const field of FIELDS) {
  const deps = pkg[field];
  if (!deps) continue;
  for (const [name, spec] of Object.entries(deps)) {
    if (isEnforceable(spec) && !hasFullBase(spec)) {
      offenders.push({ field, name, spec });
    }
  }
}

if (offenders.length > 0) {
  console.error(
    "package.json pins must specify a full major.minor.patch base " +
      "(keep the ^/~ operator). Offending pins:",
  );
  for (const { field, name, spec } of offenders) {
    console.error(`  ${field}: "${name}": "${spec}"`);
  }
  console.error(
    '\nFix each by pinning the resolved version, e.g. "^4" -> "^4.3.1".',
  );
  process.exit(1);
}

console.log(
  `package.json version pins OK (${FIELDS.join(" + ")} all full major.minor.patch).`,
);
