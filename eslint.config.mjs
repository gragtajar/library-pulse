/**
 * ESLint v9 flat config (per v2 addendum §T2).
 *
 * Three environments to handle:
 *   1. Vercel serverless handlers (JS files under backend/): ESM, Node 20 runtime.
 *   2. Figma plugin sandbox (figma-plugin/code.js): ES5-ish + `figma` global,
 *      no Node, no DOM, runs in QuickJS-like sandbox.
 *   3. Figma plugin UI (figma-plugin/ui.html): inline `<script>` browser
 *      context, has `parent.postMessage` to talk to the sandbox.
 *
 * Each gets a tailored language-options block and globals list.
 */

import js from "@eslint/js";
import globals from "globals";
import n from "eslint-plugin-n";
import importPlugin from "eslint-plugin-import";
import promise from "eslint-plugin-promise";
import security from "eslint-plugin-security";
import prettier from "eslint-config-prettier";

export default [
  // ── 0. Ignore generated / vendored ────────────────────────────────────
  {
    ignores: [
      "node_modules/**",
      ".vercel/**",
      "**/dist/**",
      "**/build/**",
      "coverage/**",
      ".husky/_/**",
      // Vitest writes transient config snapshots to the repo root; never lint them.
      "**/*.timestamp-*.mjs",
    ],
  },

  // ── 1. Base rules — every JS/MJS file ─────────────────────────────────
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    plugins: { n, import: importPlugin, promise, security },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      // Reaches: 75% of the bugs we've shipped were swallowed errors.
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-throw-literal": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "prefer-const": "error",
      "no-var": "error",
      curly: ["error", "multi-line"],
      "no-console": ["warn", { allow: ["warn", "error"] }],

      // Async correctness
      "no-async-promise-executor": "error",
      "no-promise-executor-return": "error",
      "require-atomic-updates": "error",
      "promise/no-return-wrap": "error",
      "promise/param-names": "error",
      "promise/no-promise-in-callback": "warn",

      // Import hygiene
      "import/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "ignore",
        },
      ],
      "import/no-self-import": "error",
      "import/no-useless-path-segments": "error",

      // Security
      "security/detect-eval-with-expression": "error",
      "security/detect-non-literal-fs-filename": "warn",
      "security/detect-unsafe-regex": "warn",
      "security/detect-possible-timing-attacks": "warn",
    },
  },

  // ── 2. Backend (Vercel serverless ESM, Node 20) ───────────────────────
  {
    files: ["backend/**/*.{js,mjs}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      "n/no-missing-import": "off", // Vercel/esbuild handles resolution
      "n/no-unsupported-features/node-builtins": ["error", { version: ">=22.0.0" }],
      "n/no-process-exit": "error",
      "n/no-deprecated-api": "error",
      "no-console": "error", // structured logger only, no console.log/info
    },
  },

  // ── 2b. Logger is the one module allowed to touch console ─────────────
  {
    files: ["backend/lib/logger.js"],
    rules: { "no-console": "off" },
  },

  // ── 3. Plugin sandbox (figma-plugin/code.js) ──────────────────────────
  // No Node, no DOM. `figma` is the only host API. Use `globals.browser`
  // as a loose base — Figma's QuickJS shim covers ES2020 and a small subset
  // of timers/postMessage.
  {
    files: ["figma-plugin/code.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        figma: "readonly",
        __html__: "readonly",
        // Figma exposes these:
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        console: "readonly",
      },
    },
    rules: {
      // Plugin sandbox is shipped as a single file; let it own its imports.
      "import/no-commonjs": "off",
      "n/no-unsupported-features/es-syntax": "off",
    },
  },

  // ── 4. Vitest tests ───────────────────────────────────────────────────
  {
    files: ["**/*.test.{js,mjs}", "tests/**/*.{js,mjs}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      "no-console": "off",
    },
  },

  // ── 5. Scripts (run with `node scripts/*.mjs`) ────────────────────────
  {
    files: ["scripts/**/*.{js,mjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-console": "off",
    },
  },

  // ── 6. Prettier compatibility (must be LAST) ──────────────────────────
  prettier,
];
