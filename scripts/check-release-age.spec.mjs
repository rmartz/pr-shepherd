import { describe, it, expect } from "vitest";
import { lockedPackages, parseKey } from "./check-release-age.mjs";

describe("lockedPackages", () => {
  describe("collects entries from the packages: block", () => {
    it("collects a plain versioned entry", () => {
      const lock = "packages:\n\n  react@18.3.0:\n    resolution: {}\n";
      expect([...lockedPackages(lock)]).toContain("react@18.3.0");
    });

    it("collects a scoped package entry", () => {
      const lock = "packages:\n\n  '@types/node@20.1.0':\n    resolution: {}\n";
      expect([...lockedPackages(lock)]).toContain("@types/node@20.1.0");
    });

    it("strips surrounding single quotes from quoted keys", () => {
      const lock = "packages:\n\n  'semver@7.6.0':\n    resolution: {}\n";
      const result = [...lockedPackages(lock)];
      expect(result).toContain("semver@7.6.0");
      expect(result).not.toContain("'semver@7.6.0'");
    });

    it("collects multiple entries in the same block", () => {
      const lock = [
        "packages:",
        "",
        "  react@18.3.0:",
        "    resolution: {}",
        "  lodash@4.17.21:",
        "    resolution: {}",
        "",
      ].join("\n");
      const result = lockedPackages(lock);
      expect(result.size).toBe(2);
      expect([...result]).toContain("react@18.3.0");
      expect([...result]).toContain("lodash@4.17.21");
    });
  });

  describe("ignores entries outside the packages: block", () => {
    it("does not collect entries from the snapshots: block", () => {
      const lock = "snapshots:\n\n  react@18.3.0:\n    dependencies: {}\n";
      expect(lockedPackages(lock).size).toBe(0);
    });

    it("does not collect entries from the importers: block", () => {
      const lock = "importers:\n\n  .:\n    dependencies: {}\n";
      expect(lockedPackages(lock).size).toBe(0);
    });

    it("stops collecting when the packages: block is followed by another block", () => {
      const lock = [
        "packages:",
        "",
        "  pkg-a@1.0.0:",
        "    resolution: {}",
        "",
        "snapshots:",
        "",
        "  pkg-b@2.0.0:",
        "    dependencies: {}",
        "",
      ].join("\n");
      const result = lockedPackages(lock);
      expect([...result]).toContain("pkg-a@1.0.0");
      expect([...result]).not.toContain("pkg-b@2.0.0");
    });

    it("does not collect deeply-indented nested properties inside the block", () => {
      const lock = [
        "packages:",
        "",
        "  react@18.3.0:",
        "    resolution: {integrity: sha512-abc}",
        "    engines: {node: '>=0.10.0'}",
        "",
      ].join("\n");
      const result = lockedPackages(lock);
      expect(result.size).toBe(1);
      expect([...result]).toContain("react@18.3.0");
    });
  });

  it("returns an empty set for a lockfile with no packages: block", () => {
    expect(lockedPackages("lockfileVersion: '9.0'\n").size).toBe(0);
  });
});

describe("parseKey", () => {
  it("parses a regular package", () => {
    expect(parseKey("react@18.3.0")).toEqual({
      name: "react",
      version: "18.3.0",
    });
  });

  it("parses a scoped package using the last @ as the name/version boundary", () => {
    expect(parseKey("@types/node@20.1.0")).toEqual({
      name: "@types/node",
      version: "20.1.0",
    });
  });

  it("strips a parenthetical suffix directly after the version", () => {
    // The packages: block in pnpm v9 does not include peer-dep suffixes (those
    // appear only in snapshots:), but parseKey defensively strips a ( suffix via
    // split("(")[0] when no @ appears inside the suffix.
    expect(parseKey("react@18.3.0(optional-peer)")).toEqual({
      name: "react",
      version: "18.3.0",
    });
  });

  it("accepts a pre-release version", () => {
    expect(parseKey("pkg@1.0.0-beta.1")).toEqual({
      name: "pkg",
      version: "1.0.0-beta.1",
    });
  });

  it("accepts a version with build metadata", () => {
    expect(parseKey("pkg@1.0.0+build.1")).toEqual({
      name: "pkg",
      version: "1.0.0+build.1",
    });
  });

  it("returns undefined for a workspace specifier", () => {
    expect(parseKey("my-app@workspace:packages/my-app")).toBeUndefined();
  });

  it("returns undefined for a git specifier", () => {
    expect(parseKey("pkg@github:owner/repo#abc123")).toBeUndefined();
  });

  it("returns undefined when there is no @ in the key", () => {
    expect(parseKey("react")).toBeUndefined();
  });

  it("returns undefined when @ is only at position 0 (no version boundary)", () => {
    expect(parseKey("@invalid")).toBeUndefined();
  });
});
