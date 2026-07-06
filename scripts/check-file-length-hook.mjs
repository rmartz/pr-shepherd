#!/usr/bin/env node
// Claude Code PostToolUse hook: warn the agent the moment an Edit/Write grows a
// `.ts`/`.tsx` file to or past the hard cap (source 400 / test 600), so the
// over-cap file is split immediately rather than discovered at commit or in CI.
//
// Wired from `.claude/settings.json` on Edit|Write|MultiEdit. Reads the hook
// payload (JSON) from stdin and checks only the edited file. This is the one
// edit-time signal — ESLint's `max-lines` rule (the authoritative enforcement,
// via `pnpm lint` / pre-push-verify / CI) cannot run on a PostToolUse event, so
// this hook mirrors its two caps here. Keep the limits below in sync with the
// `max-lines` blocks in `eslint.config.js` (the only two places they live).
//
// Exit 0 = fine (or not applicable); exit 2 = surface the stderr message to the
// agent. The edit has already happened — this is feedback, not prevention.

import { existsSync, readFileSync } from "node:fs";

// Mirror of eslint.config.js `max-lines`: source 400, test 600 (2x the
// recommended ~200/~300 split targets in AGENTS.md).
const SOURCE_LIMIT = 400;
const TEST_LIMIT = 600;

// A file is a "test" if it carries a spec/test extension or lives under a
// `*-tests/` directory — matching eslint.config.js's test-tier globs.
function isTestFile(path) {
  if (/\.(spec|test)\.tsx?$/.test(path)) return true;
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) => segment.endsWith("-tests"));
}

function limitFor(path) {
  return isTestFile(path)
    ? { limit: TEST_LIMIT, kind: "test" }
    : { limit: SOURCE_LIMIT, kind: "source" };
}

// Mirrors `wc -l`: the number of newline characters.
function countLines(content) {
  let count = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "\n") count += 1;
  }
  return count;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function filePathFromPayload(raw) {
  try {
    const path = JSON.parse(raw)?.tool_input?.file_path;
    return typeof path === "string" ? path : undefined;
  } catch {
    return undefined;
  }
}

const path = filePathFromPayload(readStdin());
if (
  path === undefined ||
  !(path.endsWith(".ts") || path.endsWith(".tsx")) ||
  !existsSync(path)
) {
  process.exit(0);
}

const { limit, kind } = limitFor(path);
const lines = countLines(readFileSync(path, "utf8"));
if (lines >= limit) {
  console.error(
    `${path} is now ${lines} lines — at or over the ${kind} cap of ${limit} ` +
      `(+100% of the recommended limit). Split it by logical concern now; ` +
      `ESLint's max-lines rule will block it at commit and in CI otherwise.`,
  );
  process.exit(2);
}
process.exit(0);
