#!/usr/bin/env node
// Claude Code PostToolUse hook: warn the agent the moment an Edit/Write grows a
// `.ts`/`.tsx` file to or past the hard cap (source 400 / test 600), so the
// over-cap file is split immediately rather than discovered at commit or in CI.
//
// Wired from `.claude/settings.json` on Edit|Write|MultiEdit. Reads the hook
// payload (JSON) from stdin, checks only the edited file, and reuses the shared
// limits/classification from check-file-length.mjs so the three enforcement
// points (this hook, the pre-commit hook, CI) cannot drift.
//
// Exit 0 = fine (or not applicable); exit 2 = surface the stderr message to the
// agent. The edit has already happened — this is feedback, not prevention.

import { existsSync, readFileSync } from "node:fs";
import { limitFor, countLines, exceedsCap } from "./check-file-length.mjs";

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
if (exceedsCap(lines, limit)) {
  console.error(
    `${path} is now ${lines} lines — at or over the ${kind} cap of ${limit} ` +
      `(+100% of the recommended limit). Split it by logical concern now; the ` +
      `pre-commit hook and CI will block it otherwise.`,
  );
  process.exit(2);
}
process.exit(0);
