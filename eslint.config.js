import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import storybook from "eslint-plugin-storybook";

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
