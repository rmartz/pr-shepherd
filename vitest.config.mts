import { defineConfig } from "vitest/config";
import path from "path";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.spec.ts"],
          exclude: ["src/hooks/**/*.spec.ts"],
        },
        resolve: {
          alias: { "@": path.resolve(import.meta.dirname, "./src") },
        },
      },
      {
        test: {
          name: "hooks",
          environment: "happy-dom",
          include: ["src/hooks/**/*.spec.ts"],
        },
        resolve: {
          alias: { "@": path.resolve(import.meta.dirname, "./src") },
        },
      },
      {
        test: {
          name: "components",
          environment: "happy-dom",
          include: ["src/**/*.spec.tsx"],
        },
        resolve: {
          alias: { "@": path.resolve(import.meta.dirname, "./src") },
        },
      },
      {
        test: {
          name: "tooling",
          environment: "node",
          include: ["scripts/**/*.spec.mjs", "*.spec.mjs", "*.spec.ts"],
        },
      },
      // Real-browser story suite (#255). Renders every story in headless
      // Chromium via Storybook's Vitest plugin, so layout, CSS, focus, and
      // browser APIs behave as they ship — coverage the happy-dom `components`
      // project cannot give. It needs a Playwright browser binary, so it is
      // deliberately excluded from the `Tests` CI job (which enumerates the
      // headless projects) and runs in the `storybook-tests` workflow instead.
      {
        plugins: [storybookTest()],
        test: {
          name: "storybook",
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
          setupFiles: ["@storybook/addon-vitest/internal/setup-file"],
        },
      },
    ],
  },
});
