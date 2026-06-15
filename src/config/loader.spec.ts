import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError } from "./loader";
import { DbAdapterKind } from "../db";

// A complete, valid config object. `make*` overrides let each test bend a
// single field so a failure points at exactly one cause.
function makeConfigObject(overrides: Record<string, unknown> = {}) {
  return {
    concurrency: {
      systemMax: 8,
      githubApiMax: 4,
      defaultRepoMax: 3,
    },
    repositories: [
      {
        id: "owner/example-repo",
        enabled: true,
        concurrencyMax: 2,
        workflows: [
          { match: "dependabot[bot]", workflowId: "dependabot-pr" },
          { match: "*", workflowId: "base-pr" },
        ],
      },
    ],
    poll: {
      newPrIntervalSeconds: 60,
      schedulerIntervalSeconds: 5,
      heartbeatIntervalSeconds: 15,
    },
    db: {
      adapter: "firebase-hosted",
      logOverflowPath: "./data/logs",
    },
    commands: {
      collectionPath: "commands",
      pollIntervalSeconds: 5,
    },
    ...overrides,
  };
}

let dir: string;

function writeConfig(contents: string): string {
  const path = join(dir, "config.yaml");
  writeFileSync(path, contents, "utf8");
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shepherd-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig loads and validates a valid config", () => {
  it("returns a typed Config mirroring config.example.yaml", () => {
    const path = writeConfig(JSON.stringify(makeConfigObject()));
    const config = loadConfig(path);

    expect(config.concurrency.systemMax).toBe(8);
    expect(config.repositories[0]?.id).toBe("owner/example-repo");
    expect(config.repositories[0]?.workflows[1]?.workflowId).toBe("base-pr");
    expect(config.db.adapter).toBe(DbAdapterKind.FirebaseHosted);
  });
});

describe("the committed config.example.yaml satisfies the schema", () => {
  // Guards against schema drift: the example is the discoverable template, so
  // it must always parse. Resolved from the repo root (two levels up from
  // src/config) rather than cwd so the test is location-independent.
  it("parses the repo-root config.example.yaml without error", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const examplePath = join(here, "..", "..", "config.example.yaml");
    const config = loadConfig(examplePath);

    expect(config.repositories.length).toBeGreaterThan(0);
    expect(config.db.adapter).toBe(DbAdapterKind.FirebaseHosted);
  });
});

describe("loadConfig fails fast on a missing required key", () => {
  it("throws ConfigError naming the missing key", () => {
    const object = makeConfigObject();
    delete (object.concurrency as Record<string, unknown>)["systemMax"];
    const path = writeConfig(JSON.stringify(object));

    let thrown: unknown;
    try {
      loadConfig(path);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).toContain("concurrency.systemMax");
  });
});

describe("loadConfig fails fast on a malformed value", () => {
  it("throws ConfigError naming the offending key for a non-positive number", () => {
    const path = writeConfig(
      JSON.stringify(
        makeConfigObject({ concurrency: { systemMax: -1, githubApiMax: 4 } }),
      ),
    );

    let thrown: unknown;
    try {
      loadConfig(path);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).toContain("concurrency.systemMax");
  });

  it("throws ConfigError for an unknown db adapter value", () => {
    const path = writeConfig(
      JSON.stringify(makeConfigObject({ db: { adapter: "sqlite" } })),
    );

    expect(() => loadConfig(path)).toThrow(/db\.adapter/);
  });
});

describe("loadConfig applies defaults for omitted optional keys", () => {
  it("fills repository.enabled, db.logOverflowPath, and commands from defaults", () => {
    const minimal = {
      concurrency: { systemMax: 8, githubApiMax: 4 },
      repositories: [
        {
          id: "owner/minimal-repo",
          workflows: [{ match: "*", workflowId: "base-pr" }],
        },
      ],
      db: { adapter: "in-memory" },
    };
    const path = writeConfig(JSON.stringify(minimal));
    const config = loadConfig(path);

    expect(config.concurrency.defaultRepoMax).toBe(2);
    expect(config.repositories[0]?.enabled).toBe(true);
    expect(config.repositories[0]?.concurrencyMax).toBeUndefined();
    expect(config.poll.newPrIntervalSeconds).toBe(60);
    expect(config.db.logOverflowPath).toBe("./data/logs");
    expect(config.commands.collectionPath).toBe("commands");
  });
});

describe("loadConfig fails fast on an unreadable file", () => {
  it("throws ConfigError naming the path when the file is missing", () => {
    const path = join(dir, "does-not-exist.yaml");

    expect(() => loadConfig(path)).toThrow(ConfigError);
  });
});

describe("loadConfig fails fast on invalid YAML", () => {
  it("throws ConfigError identifying the file as not valid YAML", () => {
    const path = writeConfig("concurrency: : : not valid\n  - broken");

    expect(() => loadConfig(path)).toThrow(/not valid YAML/);
  });
});
