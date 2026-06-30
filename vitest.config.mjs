import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{js,mjs}", "backend/**/*.test.{js,mjs}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["backend/lib/**/*.js", "backend/api/**/*.js"],
      exclude: ["**/*.test.*"],
      // Per v1 §4.2 — strict thresholds for the lib helpers (pure functions,
      // easy to cover). API handlers are exercised via integration tests in
      // a later phase.
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
