import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import storybook from "eslint-plugin-storybook";
import boundaries from "eslint-plugin-boundaries";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/next-env.d.ts",
      ".storybook/**",
      ".claude/**",
      ".git-worktrees/**",
      "storybook-static/**",
      "vitest.config.mts",
      "lint-staged.config.mjs",
      "src/components/ui/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "*.{ts,tsx}"],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/**/*.{ts,tsx}", "*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      // File-length hard cap (source tier: 400). max:399 so ESLint fires at
      // >399 = ≥400 (ESLint rejects files with MORE than max lines). Test
      // files + fixtures get the 600 tier in a later override (last-match-wins).
      // Replaces the bespoke file-length CI job + check-file-length.mjs.
      "max-lines": [
        "error",
        { max: 399, skipBlankLines: false, skipComments: false },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  // Root-level framework config files (Sentry, Next.js) use SDK types that don't
  // resolve cleanly under strictTypeChecked — relax unsafe-call/member rules
  {
    files: ["sentry.*.config.ts", "instrumentation.ts", "next.config.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
  // Test files use Response.json() which inherently returns `any`; relax unsafe rules
  {
    files: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  // Test files + fixtures get the 600-line tier (last-match-wins overrides the
  // 400 source cap above). max:599 so ESLint fires at ≥600, matching the
  // documented cap intent.
  {
    files: ["src/**/*.spec.{ts,tsx}", "src/**/*-tests/**/*.{ts,tsx}"],
    rules: {
      "max-lines": [
        "error",
        { max: 599, skipBlankLines: false, skipComments: false },
      ],
    },
  },
  // Vertical public-interface enforcement (eslint-plugin-boundaries).
  // Each src/engine/<vertical> is a private module: another vertical may import
  // it only through its barrel index.ts, never a deep internal path. This makes
  // the barrels load-bearing so coupling stays visible and refactors stay local.
  //
  // Only the *entry file* is constrained, not the dependency graph: cross-vertical
  // imports are allowed, they just have to resolve to the target's index.ts.
  // Imports within a vertical (same element) are not evaluated, so a vertical's
  // own files reach each other freely. The policies are last-write-wins — the
  // disallow blocks importing any engine vertical, then the allow re-permits it
  // when the resolved file is the barrel.
  //
  // Only src/engine/* is classified/enforced here; the other top-level src areas
  // are intentionally unclassified (so nothing changes for them yet). Extending
  // this to the UI/daemon areas rides with the UI feature-vertical rebalance
  // (#345), where the barrel-less ShadCN components/ui and the db/lib barrel work
  // are decided together.
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "engine-vertical", pattern: "src/engine/*" },
      ],
      "import/resolver": {
        typescript: { alwaysTryTypes: true, project: "./tsconfig.json" },
      },
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "allow",
          policies: [
            { disallow: { to: { element: { types: "engine-vertical" } } } },
            {
              // The barrel is the production public interface.
              allow: {
                to: {
                  element: {
                    types: "engine-vertical",
                    fileInternalPath: "index.ts",
                  },
                },
              },
            },
            {
              // A vertical's `<vertical>-tests/` fixtures are its test-support
              // public interface: a spec in one vertical may reuse another
              // vertical's shared fixtures (make* builders) without routing them
              // through the production barrel.
              allow: {
                to: {
                  element: {
                    types: "engine-vertical",
                    fileInternalPath: "*-tests/**",
                  },
                },
              },
            },
          ],
        },
      ],
    },
  },
  // Storybook stories use loose patterns; skip strict type checking
  {
    files: ["src/**/*.stories.tsx"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },
  ...storybook.configs["flat/recommended"],
);
