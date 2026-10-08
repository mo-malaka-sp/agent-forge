import path from "node:path";

import { resolveAgentForgeDataDir } from "@/lib/db/store";
import { getIscCredentials } from "@/lib/isc/config";

export interface SafPocConfig {
  tenant: string;
  domain: string;
  apiBase: string;
  clientId: string;
  clientSecret: string;
  ownerId: string;
  ownerName: string;
  notifyEmail: string;
  triggerName: string;
  datadogApiKey: string;
  datadogIntakeUrl: string;
  webhookToken: string;
  ssfApiToken: string;
  tableName: string;
  localStatePath: string;
}

function storedIscCredentials() {
  try {
    return getIscCredentials();
  } catch {
    return null;
  }
}

function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\/v3$/, "");
}

export function loadSafPocConfig(): SafPocConfig {
  const stored = storedIscCredentials();
  const tenant =
    process.env.SAF_TENANT?.trim() ||
    stored?.tenant ||
    process.env.ISC_TENANT?.trim() ||
    "";
  const domain =
    stored?.domain?.trim() ||
    process.env.ISC_DOMAIN?.trim() ||
    "identitynow.com";
  const explicitBase = process.env.SAF_API_BASE?.trim();
  return {
    tenant,
    domain,
    apiBase: explicitBase
      ? trimSlash(explicitBase)
      : tenant
        ? `https://${tenant}.api.${domain}`
        : "",
    clientId:
      process.env.SAF_CLIENT_ID?.trim() ||
      stored?.clientId ||
      process.env.ISC_CLIENT_ID?.trim() ||
      "",
    clientSecret:
      process.env.SAF_CLIENT_SECRET?.trim() ||
      stored?.clientSecret ||
      process.env.ISC_CLIENT_SECRET?.trim() ||
      "",
    ownerId: process.env.SAF_OWNER_ID?.trim() || "",
    ownerName: process.env.SAF_OWNER_NAME?.trim() || "",
    notifyEmail: process.env.SAF_NOTIFY_EMAIL?.trim() || "",
    triggerName:
      process.env.SAF_TRIGGER_NAME?.trim() || "CAEP Risk Level Change Events",
    datadogApiKey: process.env.DD_API_KEY?.trim() || "",
    datadogIntakeUrl:
      process.env.DATADOG_INTAKE_URL?.trim() ||
      "https://http-intake.logs.datadoghq.com/api/v2/logs",
    webhookToken: process.env.WEBHOOK_TOKEN?.trim() || "",
    ssfApiToken: process.env.SSF_API_TOKEN?.trim() || "",
    tableName: process.env.SAF_POC_TABLE_NAME?.trim() || "",
    localStatePath: path.join(resolveAgentForgeDataDir(), "saf-poc-state.json"),
  };
}

export function safPocMode(config: SafPocConfig): "dry-run" | "datadog" {
  return config.datadogApiKey ? "datadog" : "dry-run";
}
