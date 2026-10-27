// ESLint flat config. Encodes the CLAUDE.md hard rules that a linter can check.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const HEX_COLOR = "/#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?\\b/";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      ".claude/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "design/**",
      "tooling/fitness/__fixtures__/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Hard rule 8: never log with console; use packages/observability.
      "no-console": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Hard rule 6: UI uses design tokens only. No hex colors or raw px font sizes.
    files: ["apps/web/**/*.{ts,tsx}", "packages/ui/**/*.{ts,tsx}"],
    ignores: ["packages/ui/src/tokens/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `Literal[value=${HEX_COLOR}]`,
          message: "Use a design token (var(--mp-…) or packages/ui tokens) instead of a hex color.",
        },
        {
          selector: `TemplateElement[value.raw=${HEX_COLOR}]`,
          message: "Use a design token instead of a hex color.",
        },
        {
          selector: "Property[key.name='fontSize'] > Literal",
          message: "Use a typography token instead of a raw font size.",
        },
        {
          selector: "Property[key.value='font-size'] > Literal",
          message: "Use a typography token instead of a raw font size.",
        },
      ],
    },
  },
  {
    // ADR-005 / hard rule 2: the engine is deterministic. asOf is always an input.
    files: ["packages/engine/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "Pass asOf in; the engine has no clock." },
        { object: "Math", property: "random", message: "The engine is deterministic." },
        { object: "Temporal", property: "Now", message: "Pass asOf in; the engine has no clock." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date']",
          message: "Use Temporal PlainDate; never Date in the engine.",
        },
      ],
    },
  },
  {
    // Plain JS config and tooling scripts.
    files: ["**/*.{js,mjs,cjs}"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Tooling scripts talk to the terminal.
    files: ["tooling/scripts/**"],
    rules: { "no-console": "off" },
  },
);
