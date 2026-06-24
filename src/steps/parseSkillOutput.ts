// ---------------------------------------------------------------------------
// Robust stdout → structured-output parsing for the `claude_skill` executor
// (#137).
//
// The `claude` CLI is spawned without a structured-output flag, so its stdout
// may carry progress text, a banner, or streaming status *before* the final
// JSON response. Naively `JSON.parse`-ing the whole stream therefore fails on
// any preamble, and silently wrapping the lot in `{ raw }` hands downstream
// step logic `undefined` for every expected key with no signal that parsing
// failed.
//
// `parseSkillOutput` recovers the structured object instead of guessing:
//   1. parse the whole trimmed stream (the clean, flag-or-quiet-CLI case);
//   2. else scan lines bottom-up for the last line that is a JSON object
//      (handles preamble/progress lines before a final JSON line);
//   3. else scan for the last balanced `{...}` span anywhere in the stream
//      (handles JSON not isolated on its own line);
//   4. else throw `SkillOutputParseError` so the step fails loudly with a
//      diagnostic rather than returning `{ raw }`.
//
// Empty/whitespace-only output is a legitimate "no structured result" and
// returns `{}` — only *non-empty, unparseable* output is an error.
// ---------------------------------------------------------------------------

export class SkillOutputParseError extends Error {
  // The raw stdout that could not be parsed, preserved for diagnostics.
  readonly rawOutput: string;

  constructor(rawOutput: string) {
    const preview = rawOutput.trim().slice(-200);
    super(
      `claude subprocess emitted no parseable JSON object on stdout; ` +
        `last 200 chars: ${preview}`,
    );
    this.name = "SkillOutputParseError";
    this.rawOutput = rawOutput;
  }
}

// Parse `text` as a JSON object, returning `undefined` for anything that is
// not a plain (non-array, non-null) object — arrays, primitives, and parse
// errors all yield `undefined` so callers can keep scanning.
function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

// Scan `lines` from the bottom up, returning the last line that parses as a
// JSON object. Lets a final JSON line win over earlier progress/banner lines.
function lastObjectLine(lines: string[]): Record<string, unknown> | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = tryParseObject((lines[i] ?? "").trim());
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

// Find the last balanced top-level `{...}` span in `text` and parse it as a
// JSON object. Handles JSON that shares a line with preamble (e.g.
// `done: {"verdict":"approved"}`). Brace depth is tracked while ignoring
// braces inside JSON strings (with escape handling) so embedded `{`/`}` in
// string values do not skew the span boundaries.
function lastObjectSpan(text: string): Record<string, unknown> | undefined {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let lastSpan: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) lastSpan = text.slice(start, i + 1);
      }
    }
  }
  return lastSpan === undefined ? undefined : tryParseObject(lastSpan);
}

export function parseSkillOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return {};

  const whole = tryParseObject(trimmed);
  if (whole !== undefined) return whole;

  const byLine = lastObjectLine(trimmed.split("\n"));
  if (byLine !== undefined) return byLine;

  const bySpan = lastObjectSpan(trimmed);
  if (bySpan !== undefined) return bySpan;

  throw new SkillOutputParseError(stdout);
}
