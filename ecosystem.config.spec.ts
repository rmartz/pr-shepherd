import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

interface PM2App {
  name: string;
  script: string;
  args: string;
  exec_mode: string;
  instances: number;
  autorestart: boolean;
  exp_backoff_restart_delay: number;
  max_restarts: number;
  min_uptime: string;
}

interface PM2Ecosystem {
  apps: PM2App[];
}

// The PM2 ecosystem file is CommonJS (`module.exports`), so load it via a
// `require` rather than ESM `import`. This proves the `.cjs` file parses
// and exports a single, sensibly-configured `shepherd` app — a syntax
// error or a renamed setting would fail here before an operator hits it.
const ecosystem = createRequire(import.meta.url)(
  "./ecosystem.config.cjs",
) as PM2Ecosystem;

describe("ecosystem.config.cjs launches `shepherd start` under PM2", () => {
  const [app, ...rest] = ecosystem.apps;

  it("declares exactly one app named shepherd", () => {
    expect(rest).toHaveLength(0);
    expect(app?.name).toBe("shepherd");
  });

  it("runs the `shepherd start` CLI in single-instance fork mode", () => {
    expect(app?.script).toBe("shepherd");
    expect(app?.args).toBe("start");
    expect(app?.exec_mode).toBe("fork");
    expect(app?.instances).toBe(1);
  });

  it("auto-restarts with exponential backoff and a bounded retry count", () => {
    expect(app?.autorestart).toBe(true);
    expect(app?.exp_backoff_restart_delay).toBe(1000);
    expect(app?.max_restarts).toBe(10);
    expect(app?.min_uptime).toBe("10s");
  });
});
