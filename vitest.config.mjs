import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{js,mjs}", "backend/**/*.test.{js,mjs}"],
    // Dummy env so modules that fail-fast on missing config (e.g. supabase.js,
    // which throws at import if SUPABASE_URL is unset) can be imported by unit
    // tests. These are never used to reach a real service — the pure helpers
    // under test never issue a query.
    env: {
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    },
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
