#!/usr/bin/env node
// @ts-check
/**
 * Validate figma-plugin/manifest.json against the documented schema for
 * Figma plugin manifests (api 1.0.0+). Run in CI.
 *
 * Caveat: Figma doesn't publish a formal JSON Schema, so we encode the
 * documented constraints from https://www.figma.com/plugin-docs/manifest/.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Ajv from "ajv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(__dirname, "../figma-plugin/manifest.json");

const schema = {
  type: "object",
  required: ["name", "id", "api", "main", "editorType"],
  additionalProperties: true,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    id: { type: "string", minLength: 1 },
    api: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
    main: { type: "string", pattern: "\\.(js|ts)$" },
    ui: { type: "string", pattern: "\\.(html|js|ts)$" },
    editorType: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { enum: ["figma", "figjam", "dev", "slides"] },
    },
    documentAccess: { enum: ["dynamic-page"] },
    networkAccess: {
      type: "object",
      required: ["allowedDomains"],
      additionalProperties: false,
      properties: {
        allowedDomains: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^https?://[^\\s/]+$|^\\*$" },
        },
        reasoning: { type: "string", minLength: 10 },
        devAllowedDomains: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
    permissions: { type: "array", items: { type: "string" } },
    enableProposedApi: { type: "boolean" },
    parameters: { type: "array" },
    menu: { type: "array" },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

const text = await readFile(MANIFEST_PATH, "utf8");
let json;
try {
  json = JSON.parse(text);
} catch (err) {
  console.error(`✘ manifest.json is not valid JSON: ${err.message}`);
  process.exit(1);
}

if (!validate(json)) {
  console.error("✘ figma-plugin/manifest.json failed schema validation:");
  for (const err of validate.errors ?? []) {
    console.error(`  - ${err.instancePath || "/"} ${err.message}`);
  }
  process.exit(1);
}

// Extra rules not expressible in JSON Schema:
if (!json.ui && !Array.isArray(json.menu) && json.parameters === undefined) {
  console.error("✘ manifest declares no ui, menu, or parameters — plugin will be invisible.");
  process.exit(1);
}

if (json.networkAccess?.reasoning && json.networkAccess.reasoning.length < 20) {
  console.error("✘ networkAccess.reasoning is shorter than 20 characters — reviewers will reject it.");
  process.exit(1);
}

console.log(`✔ ${MANIFEST_PATH.split("/").slice(-2).join("/")} valid`);
