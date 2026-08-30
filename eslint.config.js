import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";

export default defineConfig([
  globalIgnores(["dist", "node_modules", "public"]),

  {
    files: ["**/*.ts"],
    ignores: ["src/configpanel/**"],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    languageOptions: {
      parser: tseslint.parser,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": "error",
    },
  },

  // Browser-side config panel (webpack + babel-loader, not tsc).
  {
    files: ["src/configpanel/**/*.tsx", "src/configpanel/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": "error",
    },
  },

  // The panel build config (CommonJS because the package itself is ESM).
  {
    files: ["webpack.config.cjs"],
    extends: [js.configs.recommended, prettier],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node,
    },
  },
]);
