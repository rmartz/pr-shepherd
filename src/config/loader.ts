import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type { z } from "zod";
import { ConfigSchema, type Config } from "./schema";

// Default path the daemon reads when no explicit path is given. Resolved
// relative to the process working directory so `shepherd start` picks up the
// `config.yaml` sitting next to `config.example.yaml` in the repo root.
const DEFAULT_CONFIG_PATH = "config.yaml";

// Thrown when the config cannot be loaded or fails validation. The message is
// operator-facing: it names the file and, for validation failures, the exact
// key and what was expected — so a misconfiguration fails fast with an
// actionable diagnosis rather than a cryptic stack trace.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// Renders a ZodError into a multi-line, per-issue summary. Each line reads
// `  - <dotted.path>: <message>` so the operator sees which key failed and
// why. The root object is shown as `<root>` when an issue has no path.
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
}

// Loads, parses, and validates the daemon config from `path` (default
// `config.yaml`). Returns a fully-typed `Config` with all optional fields
// resolved to their defaults. Throws `ConfigError` with an actionable message
// when the file is missing, is not valid YAML, or violates the schema.
export function loadConfig(path: string = DEFAULT_CONFIG_PATH): Config {
  const absolutePath = resolve(path);

  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf8");
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigError(
      `Could not read config file at ${absolutePath}: ${detail}. ` +
        `Copy config.example.yaml to config.yaml and edit it.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (cause) {
    const detail =
      cause instanceof YAMLParseError
        ? cause.message
        : cause instanceof Error
          ? cause.message
          : String(cause);
    throw new ConfigError(
      `Config file ${absolutePath} is not valid YAML: ${detail}`,
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Config file ${absolutePath} failed validation:\n${formatIssues(result.error)}`,
    );
  }

  return result.data;
}
