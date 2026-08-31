#!/usr/bin/env node
/**
 * Prepare golden SP-Config JSON from a raw tenant export.
 *
 * Usage:
 *   node scripts/prepare-isc-sp-config.mjs \
 *     --input config/isc/exports/aws-bedrock.raw.json \
 *     --output config/isc/golden/aws-bedrock.sp-config.json \
 *     --base-url https://main.d12mzah9vzl24s.amplifyapp.com
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TOKEN = "{{AGENTFORGE_BASE_URL}}";
const SECRET_KEYS = new Set([
  "password",
  "clientSecret",
  "client_secret",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "privateKey",
  "private_key",
]);

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    baseUrl: "https://main.d12mzah9vzl24s.amplifyapp.com",
    blankSourceId: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--input" && value) {
      args.input = value;
      i += 1;
    } else if (flag === "--output" && value) {
      args.output = value;
      i += 1;
    } else if (flag === "--base-url" && value) {
      args.baseUrl = value.replace(/\/$/, "");
      i += 1;
    } else if (flag === "--blank-source-id") {
      args.blankSourceId = true;
    }
  }

  if (!args.input || !args.output) {
    console.error(
      "Usage: node scripts/prepare-isc-sp-config.mjs --input <raw.json> --output <golden.json> [--base-url URL] [--blank-source-id]",
    );
    process.exit(1);
  }

  return args;
}

function stripSecrets(node) {
  if (Array.isArray(node)) {
    return node.map(stripSecrets);
  }
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (SECRET_KEYS.has(key)) {
        out[key] = "";
        continue;
      }
      out[key] = stripSecrets(value);
    }
    return out;
  }
  return node;
}

function blankSourceObjectIds(node) {
  if (Array.isArray(node)) {
    return node.map(blankSourceObjectIds);
  }
  if (node && typeof node === "object") {
    const out = { ...node };
    if (out.object && typeof out.object === "object" && out.object.type === "SOURCE") {
      out.object = { ...out.object, id: "" };
    }
    for (const key of Object.keys(out)) {
      if (key !== "object") {
        out[key] = blankSourceObjectIds(out[key]);
      }
    }
    return out;
  }
  return node;
}

function stripTenantRuntimeState(node) {
  if (Array.isArray(node)) {
    return node.map(stripTenantRuntimeState);
  }
  if (node && typeof node === "object") {
    const out = { ...node };
    delete out.recommendationStatus;
    for (const key of Object.keys(out)) {
      out[key] = stripTenantRuntimeState(out[key]);
    }
    return out;
  }
  return node;
}

function stripEmptyGroupEntitlementSchemas(node) {
  if (Array.isArray(node)) {
    return node
      .map(stripEmptyGroupEntitlementSchemas)
      .filter((item) => {
        if (!item || typeof item !== "object") {
          return true;
        }
        const name = String(
          item.name ?? item.nativeObjectType ?? "",
        ).toLowerCase();
        const attributes = item.attributes;
        const isEmptyGroup =
          name === "group" &&
          (!Array.isArray(attributes) || attributes.length === 0);
        return !isEmptyGroup;
      });
  }
  if (node && typeof node === "object") {
    const out = { ...node };
    if (Array.isArray(out.schemas)) {
      out.schemas = out.schemas.filter((schema) => {
        if (!schema || typeof schema !== "object") {
          return true;
        }
        const name = String(schema.name ?? schema.nativeObjectType ?? "");
        const attributes = schema.attributes;
        const isEmptyGroup =
          name === "group" &&
          (!Array.isArray(attributes) || attributes.length === 0);
        return !isEmptyGroup;
      });
    }
    for (const key of Object.keys(out)) {
      if (key !== "schemas") {
        out[key] = stripEmptyGroupEntitlementSchemas(out[key]);
      }
    }
    return out;
  }
  return node;
}

const OWNER_SCHEMA_ATTRIBUTE = {
  name: "owner",
  nativeName: null,
  type: "STRING",
  schema: null,
  description: "owner",
  isMulti: false,
  isEntitlement: false,
  isGroup: false,
  isManaged: false,
};

const PLATFORM_SCHEMA_ATTRIBUTE = {
  name: "platform",
  nativeName: null,
  type: "STRING",
  schema: null,
  description: "platform",
  isMulti: false,
  isEntitlement: false,
  isGroup: false,
  isManaged: false,
};

function schemaHasAttribute(schema, name) {
  return (schema.attributes ?? []).some((attr) => attr.name === name);
}

function ensureOwnerSchemaAttributes(node) {
  if (Array.isArray(node)) {
    return node.map(ensureOwnerSchemaAttributes);
  }
  if (node && typeof node === "object") {
    const out = { ...node };
    if (Array.isArray(out.schemas)) {
      out.schemas = out.schemas.map((schema) => {
        if (!schema || typeof schema !== "object") {
          return schema;
        }
        const config = schema.configuration ?? {};
        const isAgentResource =
          config.resourceType === "std:agent" ||
          config.datasetType === "std:machine-identity" ||
          (typeof config.datasetId === "string" &&
            typeof config.resourceId === "string");
        const isAccount =
          schema.nativeObjectType === "User" || schema.name === "account";
        const attributes = [...(schema.attributes ?? [])];

        if ((isAccount || isAgentResource) && !schemaHasAttribute(schema, "owner")) {
          attributes.push({ ...OWNER_SCHEMA_ATTRIBUTE });
        }
        if (isAgentResource && !schemaHasAttribute(schema, "platform")) {
          attributes.push({ ...PLATFORM_SCHEMA_ATTRIBUTE });
        }

        return { ...schema, attributes };
      });
    }
    for (const key of Object.keys(out)) {
      if (key !== "schemas") {
        out[key] = ensureOwnerSchemaAttributes(out[key]);
      }
    }
    return out;
  }
  return node;
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = resolve(args.input);
  const outputPath = resolve(args.output);

  let text = readFileSync(inputPath, "utf8");
  const base = args.baseUrl.replace(/\/$/, "");

  // Replace known base URL variants before JSON parse (handles strings in config).
  const variants = [
    base,
    base.replace("https://", "http://"),
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];
  for (const variant of variants) {
    if (variant) {
      text = text.split(variant).join(TOKEN);
    }
  }

  let data = JSON.parse(text);
  data = stripSecrets(data);
  data = stripTenantRuntimeState(data);
  data = stripEmptyGroupEntitlementSchemas(data);
  data = ensureOwnerSchemaAttributes(data);
  if (args.blankSourceId) {
    data = blankSourceObjectIds(data);
  }

  writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outputPath}`);
  console.log(`Base URL token: ${TOKEN}`);
}

main();
