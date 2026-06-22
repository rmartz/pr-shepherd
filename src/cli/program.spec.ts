import { describe, expect, it, vi } from "vitest";
import {
  buildProgram,
  ShepherdCommand,
  type ShepherdHandlers,
} from "./program";

// Build a program backed entirely by spy handlers so dispatch can be
// asserted without touching the real handlers (and so no real Firestore
// or engine bootstrap is ever reached).
async function resolved(): Promise<void> {
  await Promise.resolve();
}

function makeSpyHandlers(): ShepherdHandlers {
  return {
    forceRetry: vi.fn(resolved),
    inspect: vi.fn(resolved),
    start: vi.fn(resolved),
    status: vi.fn(resolved),
  };
}

async function parse(
  handlers: ShepherdHandlers,
  args: readonly string[],
): Promise<void> {
  await buildProgram(handlers).parseAsync(args, { from: "user" });
}

describe("buildProgram dispatches each subcommand to its handler", () => {
  it("routes `start` to the start handler", async () => {
    const handlers = makeSpyHandlers();
    await parse(handlers, [ShepherdCommand.Start]);
    expect(handlers.start).toHaveBeenCalledTimes(1);
    expect(handlers.status).not.toHaveBeenCalled();
  });

  it("routes `status` to the status handler", async () => {
    const handlers = makeSpyHandlers();
    await parse(handlers, [ShepherdCommand.Status]);
    expect(handlers.status).toHaveBeenCalledTimes(1);
    expect(handlers.start).not.toHaveBeenCalled();
  });

  it("routes `force-retry` to its handler with the runId argument", async () => {
    const handlers = makeSpyHandlers();
    await parse(handlers, [ShepherdCommand.ForceRetry, "run-42"]);
    expect(handlers.forceRetry).toHaveBeenCalledTimes(1);
    expect(handlers.forceRetry).toHaveBeenCalledWith("run-42");
  });

  it("routes `inspect` to its handler with the runId argument", async () => {
    const handlers = makeSpyHandlers();
    await parse(handlers, [ShepherdCommand.Inspect, "run-99"]);
    expect(handlers.inspect).toHaveBeenCalledTimes(1);
    expect(handlers.inspect).toHaveBeenCalledWith("run-99");
  });
});

describe("buildProgram enforces required arguments", () => {
  it("rejects `force-retry` without a runId", async () => {
    const handlers = makeSpyHandlers();
    await expect(
      parse(handlers, [ShepherdCommand.ForceRetry]),
    ).rejects.toMatchObject({ code: "commander.missingArgument" });
    expect(handlers.forceRetry).not.toHaveBeenCalled();
  });

  it("rejects an unknown subcommand", async () => {
    const handlers = makeSpyHandlers();
    await expect(parse(handlers, ["nonsense"])).rejects.toMatchObject({
      code: "commander.unknownCommand",
    });
  });
});

describe("buildProgram registers all four subcommands plus help", () => {
  it("exposes exactly the four epic subcommands", () => {
    const names = buildProgram(makeSpyHandlers())
      .commands.map((command) => command.name())
      .sort();
    expect(names).toEqual([
      ShepherdCommand.ForceRetry,
      ShepherdCommand.Inspect,
      ShepherdCommand.Start,
      ShepherdCommand.Status,
    ]);
  });

  it("includes each subcommand in the --help output", () => {
    const help = buildProgram(makeSpyHandlers()).helpInformation();
    expect(help).toContain(ShepherdCommand.Start);
    expect(help).toContain(ShepherdCommand.Status);
    expect(help).toContain(ShepherdCommand.ForceRetry);
    expect(help).toContain(ShepherdCommand.Inspect);
  });
});
