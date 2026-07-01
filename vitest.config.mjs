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
      // Per v1 §4.2 — thresholds gate the pure-logic helpers that are
      // unit-tested here. API route handlers and IO-bound modules (supabase,
      // http, logger, oauth pages, the DB-touching parts of idempotency /
      // auth-session) are exercised by integration tests in a later phase and
      // are intentionally out of the coverage gate rather than faking a
      // Supabase/fetch layer just to inflate the number.
      include: [
        "backend/lib/encryption.js",
        "backend/lib/errors.js",
        "backend/lib/escape.js",
        "backend/lib/session.js",
        "backend/lib/slack-blocks.js",
        "backend/lib/validators.js",
      ],
      exclude: ["**/*.test.*"],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
