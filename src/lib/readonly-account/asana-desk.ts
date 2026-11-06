import fs from "node:fs";
import path from "node:path";

import { resolveAgentForgeDataDir } from "@/lib/db/store";
import { readonlyAccountClient } from "@/lib/readonly-account/tenant";
import { loadSafPocConfig } from "@/lib/saf-poc/config";
import type { SailPointSetupConfig } from "@/lib/saf-poc/sailpoint";
import { getSafPocStore, type SafPocStore } from "@/lib/saf-poc/storage";

export type AsanaDeskConfig = {
  asanaToken: string;
  tenant: string;
  clientId: string;
  clientSecret: string;
  projectName: string;
  triggerStatus: string;
  workingStatus: string;
  doneStatus: string;
  declinedStatus: string;
  accountField: string;
  codeField: string;
  tenantLinkField: string;
  tenantLinkTemplate: string;
};

export type AsanaDeskPublic = {
  asanaTokenSet: boolean;
  clientSecretSet: boolean;
  tenant: string;
  clientId: string;
  projectName: string;
  triggerStatus: string;
  workingStatus: string;
  doneStatus: string;
  declinedStatus: string;
  accountField: string;
  codeField: string;
  tenantLinkField: string;
  tenantLinkTemplate: string;
};

export function defaultAsanaDesk(): AsanaDeskConfig {
  return {
    asanaToken: "",
    tenant: "",
    clientId: "",
    clientSecret: "",
    projectName: "Test Drive Requests - Testing",
    triggerStatus: "New request",
    workingStatus: "Evaluation",
    doneStatus: "Implemented",
    declinedStatus: "Declined",
    accountField: "Sandbox account",
    codeField: "Initial password",
    tenantLinkField: "",
    tenantLinkTemplate: "https://{tenant}.identitynow-demo.com",
  };
}

export function asanaDeskPublic(config: AsanaDeskConfig): AsanaDeskPublic {
  return {
    asanaTokenSet: Boolean(config.asanaToken),
    clientSecretSet: Boolean(config.clientSecret),
    tenant: config.tenant,
    clientId: config.clientId,
    projectName: config.projectName,
    triggerStatus: config.triggerStatus,
    workingStatus: config.workingStatus,
    doneStatus: config.doneStatus,
    declinedStatus: config.declinedStatus,
    accountField: config.accountField,
    codeField: config.codeField,
    tenantLinkField: config.tenantLinkField,
    tenantLinkTemplate: config.tenantLinkTemplate,
  };
}

export function tenantLink(config: AsanaDeskConfig): string {
  const tenant = sailPointEndpoint(config.tenant).tenant || loadSafPocConfig().tenant;
  return config.tenantLinkTemplate.replaceAll("{tenant}", tenant);
}

export function sailPointEndpoint(value: string): { tenant: string; apiBase: string } {
  const raw = value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const host = raw.replace(/\.api\./, ".");
  if (host.includes(".")) {
    const tenant = host.split(".")[0] ?? "";
    const domain = host.slice(tenant.length + 1);
    return { tenant, apiBase: `https://${tenant}.api.${domain}` };
  }
  return {
    tenant: host,
    apiBase: host ? `https://${host}.api.identitynow-demo.com` : "",
  };
}

const DESK_KEY = "READONLY_ACCOUNT#asana-desk";

export async function loadAsanaDesk(
  filePath = deskPath(),
  store?: SafPocStore | null,
): Promise<AsanaDeskConfig> {
  const shared = resolveDeskStore(filePath, store);
  if (shared) {
    try {
      const stored = await shared.get<Partial<AsanaDeskConfig>>(DESK_KEY);
      if (stored) {
        return normalizeDesk({ ...defaultAsanaDesk(), ...stored });
      }
    } catch {
      // A shared-store miss falls back to this server's file.
    }
  }
  return readDeskFile(filePath);
}

function readDeskFile(filePath: string): AsanaDeskConfig {
  const defaults = defaultAsanaDesk();
  if (!fs.existsSync(filePath)) {
    return defaults;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<AsanaDeskConfig>;
    return normalizeDesk({ ...defaults, ...parsed });
  } catch {
    return defaults;
  }
}

export function missingDeskFields(config: AsanaDeskConfig): string[] {
  const checks: Array<[string, string]> = [
    ["Asana access token", config.asanaToken],
    ["SailPoint tenant", config.tenant],
    ["SailPoint client id", config.clientId],
    ["SailPoint client secret", config.clientSecret],
    ["Tenant link field", config.tenantLinkField],
  ];
  return checks.filter(([, value]) => !value.trim()).map(([label]) => label);
}

export async function saveAsanaDesk(
  input: Partial<AsanaDeskConfig>,
  filePath = deskPath(),
  store?: SafPocStore | null,
): Promise<AsanaDeskConfig> {
  const current = await loadAsanaDesk(filePath, store);
  const next = normalizeDesk({
    ...current,
    ...input,
    asanaToken: input.asanaToken?.trim() || current.asanaToken,
    clientSecret: input.clientSecret?.trim() || current.clientSecret,
  });
  const missing = missingDeskFields(next);
  if (missing.length > 0) {
    throw new Error(`Enter ${missing.join(", ")} before connecting.`);
  }
  const shared = resolveDeskStore(filePath, store);
  if (shared) {
    await shared.put(DESK_KEY, next);
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
  } catch (error) {
    if (!shared) {
      throw error;
    }
  }
  return next;
}

function resolveDeskStore(filePath: string, store?: SafPocStore | null): SafPocStore | null {
  if (store === null) {
    return null;
  }
  if (store) {
    return store;
  }
  if (filePath !== deskPath() || !process.env.SAF_POC_TABLE_NAME?.trim()) {
    return null;
  }
  return getSafPocStore();
}

export function asanaAccessToken(override?: string, config?: AsanaDeskConfig): string {
  return override?.trim() || config?.asanaToken || process.env.ASANA_ACCESS_TOKEN?.trim() || "";
}

export function sailPointClientForDesk(config?: AsanaDeskConfig) {
  if (config?.clientId && config.clientSecret && config.tenant) {
    return readonlyAccountClient(sailPointConfig(config));
  }
  return readonlyAccountClient();
}

function sailPointConfig(config: AsanaDeskConfig): SailPointSetupConfig {
  const endpoint = sailPointEndpoint(config.tenant);
  return {
    tenant: endpoint.tenant,
    apiBase: endpoint.apiBase,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    ownerId: "",
    ownerName: "",
    triggerName: "CAEP Risk Level Change Events",
    notifyEmail: "",
  };
}

function normalizeDesk(config: AsanaDeskConfig): AsanaDeskConfig {
  const defaults = defaultAsanaDesk();
  const text = (value: string | undefined, fallback: string) => {
    const trimmed = value?.trim() ?? "";
    return trimmed || fallback;
  };
  return {
    asanaToken: config.asanaToken?.trim() ?? "",
    tenant: config.tenant?.trim() ?? "",
    clientId: config.clientId?.trim() ?? "",
    clientSecret: config.clientSecret?.trim() ?? "",
    projectName: text(config.projectName, defaults.projectName),
    triggerStatus: text(config.triggerStatus, defaults.triggerStatus),
    workingStatus: text(config.workingStatus, defaults.workingStatus),
    doneStatus:
      text(config.doneStatus, defaults.doneStatus).toLowerCase() === "approved"
        ? defaults.doneStatus
        : text(config.doneStatus, defaults.doneStatus),
    declinedStatus: text(config.declinedStatus, defaults.declinedStatus),
    accountField: text(config.accountField, defaults.accountField),
    codeField: text(config.codeField, defaults.codeField),
    tenantLinkField: config.tenantLinkField?.trim() ?? "",
    tenantLinkTemplate: text(config.tenantLinkTemplate, defaults.tenantLinkTemplate),
  };
}

function deskPath(): string {
  return path.join(resolveAgentForgeDataDir(), "readonly-account-asana-desk.json");
}
