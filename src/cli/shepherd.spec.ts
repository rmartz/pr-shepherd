import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./shepherd";

// The entrypoint wires the default handlers. `start` now boots the engine
// (#207); the remaining handlers (`status`, `force-retry`, `inspect`) are still
// scaffolds that throw NotImplementedError. These tests assert how `main` maps
// those outcomes — and commander's parse errors — onto process exit codes,
// without spawning the binary or touching Firestore.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("main maps an unimplemented subcommand to a clean failure", () => {
  it("returns exit code 1 and prints the not-yet-implemented message", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = await main(["status"]);
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("not yet implemented"),
    );
  });
});

describe("main handles --help without erroring", () => {
  it("returns exit code 0 and writes help to stdout", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const code = await main(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("force-retry"));
  });
});

describe("main maps a parse error to a nonzero exit code", () => {
  it("returns a nonzero code for an unknown subcommand", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await main(["nonsense"]);
    expect(code).not.toBe(0);
  });
});
