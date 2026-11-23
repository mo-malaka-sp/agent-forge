import path from "node:path";

import { resolveAgentForgeDataDir } from "@/lib/db/store";
import { getIscCredentials } from "@/lib/isc/config";
import { getActiveIscRuntime, type IscRuntimePayload } from "@/lib/isc/runtime-config";

export interface SafPocConfig {
  tenant: string;
  domain: string;
  apiBase: string;
  clientId: string;
  clientSecret: string;
  passwordClientId: string;
  passwordClientSecret: string;
  ownerId: string;
  ownerName: string;
  notifyEmail: string;
  triggerName: string;
  datadogApiKey: string;
  datadogAppKey: string;
  datadogIntakeUrl: string;
  webhookToken: string;
  ssfApiToken: string;
  workerToken: string;
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

/** Settings shared by every tenant: account-level keys, tokens, and storage. */
function sharedSafPocSettings() {
  return {
    datadogApiKey: process.env.DD_API_KEY?.trim() || "",
    datadogAppKey: process.env.DD_APP_KEY?.trim() || "",
    datadogIntakeUrl:
      process.env.DATADOG_INTAKE_URL?.trim() ||
      "https://http-intake.logs.datadoghq.com/api/v2/logs",
    webhookToken: process.env.WEBHOOK_TOKEN?.trim() || "",
    ssfApiToken: process.env.SSF_API_TOKEN?.trim() || "",
    workerToken: process.env.SAF_POC_WORKER_TOKEN?.trim() || "",
    tableName: process.env.SAF_POC_TABLE_NAME?.trim() || "",
    localStatePath: path.join(resolveAgentForgeDataDir(), "saf-poc-state.json"),
  };
}

/** Config for a tenant bound to the feature. Its saved profile is the only source of tenant data. */
function configFromRuntime(runtime: IscRuntimePayload): SafPocConfig {
  const tenant = runtime.tenant.trim();
  const domain = runtime.domain?.trim() || "identitynow.com";
  const saf = runtime.saf ?? {};
  return {
    tenant,
    domain,
    apiBase: `https://${tenant}.api.${domain}`,
    clientId: runtime.client_id.trim(),
    clientSecret: runtime.client_secret.trim(),
    passwordClientId: saf.passwordClientId?.trim() || "",
    passwordClientSecret: saf.passwordClientSecret?.trim() || "",
    ownerId: saf.ownerId?.trim() || "",
    ownerName: saf.ownerName?.trim() || "",
    notifyEmail: saf.notifyEmail?.trim() || "",
    triggerName: saf.triggerName?.trim() || "CAEP Risk Level Change Events",
    ...sharedSafPocSettings(),
  };
}

export function loadSafPocConfig(): SafPocConfig {
  const runtime = getActiveIscRuntime();
  if (runtime) {
    return configFromRuntime(runtime);
  }

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
    passwordClientId: process.env.SAF_PASSWORD_CLIENT_ID?.trim() || "",
    passwordClientSecret: process.env.SAF_PASSWORD_CLIENT_SECRET?.trim() || "",
    ownerId: process.env.SAF_OWNER_ID?.trim() || "",
    ownerName: process.env.SAF_OWNER_NAME?.trim() || "",
    notifyEmail: process.env.SAF_NOTIFY_EMAIL?.trim() || "",
    triggerName:
      process.env.SAF_TRIGGER_NAME?.trim() || "CAEP Risk Level Change Events",
    ...sharedSafPocSettings(),
  };
}

export function safPocMode(config: SafPocConfig): "dry-run" | "datadog" {
  return config.datadogApiKey ? "datadog" : "dry-run";
}
