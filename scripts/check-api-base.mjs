#!/usr/bin/env node
// @ts-check
/**
 * Drift check: every URL the plugin UI talks to MUST be declared in
 * manifest.json's `networkAccess.allowedDomains`. If a developer hard-codes
 * a new `API_BASE` and forgets to add it to the manifest, Figma will silently
 * block the request at runtime.
 *
 * Failing this check in CI catches the drift before publish.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = resolve(__dirname, "../figma-plugin/manifest.json");
const UI = resolve(__dirname, "../figma-plugin/ui.html");

const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
const ui = await readFile(UI, "utf8");

const allowed = new Set(manifest.networkAccess?.allowedDomains ?? []);
if (allowed.has("*")) {
  console.warn(
    "⚠ manifest allows '*' for network access — that's almost never OK for a published plugin.",
  );
}

// Collect every absolute URL the UI references.
const urlRe = /https?:\/\/[^\s"'<>`)]+/g;
const found = new Set();
for (const match of ui.matchAll(urlRe)) {
  try {
    const u = new URL(match[0]);
    found.add(`${u.protocol}//${u.host}`);
  } catch {
    /* ignore non-URLs */
  }
}

// Subtract well-known Figma-internal hosts and SVG namespace URIs.
const ignore = new Set(["http://www.w3.org", "https://www.w3.org"]);

const missing = [...found].filter((origin) => !allowed.has(origin) && !ignore.has(origin));

if (missing.length > 0 && !allowed.has("*")) {
  console.error(
    "✘ figma-plugin/ui.html references origins not declared in manifest.allowedDomains:",
  );
  for (const m of missing) console.error(`  - ${m}`);
  console.error(`\nFix: add them to figma-plugin/manifest.json's networkAccess.allowedDomains.`);
  process.exit(1);
}

console.log(`✔ All ${found.size} UI origins are declared in manifest`);
