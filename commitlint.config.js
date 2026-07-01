/**
 * Conventional Commits (v1 spec §3.5).
 *
 * Allowed `type` values, with notes on when to use which:
 *   feat:     user-visible new functionality
 *   fix:      bug fix that ships
 *   perf:     measurable performance improvement
 *   refactor: code reorg with no behaviour change
 *   docs:     README/ADR/runbook updates
 *   test:     adding or improving tests
 *   build:    package.json / vercel.json / schema migrations
 *   ci:       GitHub Actions, husky
 *   chore:    dependency bumps, lint fixes that no one will ever see
 *   security: explicit security fix (CVE, hardening); release notes worthy
 *   revert:   `git revert`
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "perf",
        "refactor",
        "docs",
        "test",
        "build",
        "ci",
        "chore",
        "security",
        "revert",
      ],
    ],
    "header-max-length": [2, "always", 100],
    "body-max-line-length": [1, "always", 120],
    "subject-case": [2, "never", ["upper-case", "pascal-case", "start-case"]],
    "scope-case": [2, "always", "kebab-case"],
  },
};
