import fs from "node:fs";
import path from "node:path";

import { resolveAgentForgeDataDir } from "@/lib/db/store";
import { readonlyAccountClient } from "@/lib/readonly-account/tenant";
import { loadSafPocConfig } from "@/lib/saf-poc/config";
import type { SailPointSetupConfig } from "@/lib/saf-poc/sailpoint";

export type AsanaDeskConfig = {
  asanaToken: string;
  tenant: string;
  clientId: string;
  clientSecret: string;
  projectName: string;
  triggerStatus: string;
  workingStatus: string;
  doneStatus: string;
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
    doneStatus: "Approved",
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

export function loadAsanaDesk(filePath = deskPath()): AsanaDeskConfig {
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

export function saveAsanaDesk(
  input: Partial<AsanaDeskConfig>,
  filePath = deskPath(),
): AsanaDeskConfig {
  const current = loadAsanaDesk(filePath);
  const next = normalizeDesk({
    ...current,
    ...input,
    asanaToken: input.asanaToken?.trim() || current.asanaToken,
    clientSecret: input.clientSecret?.trim() || current.clientSecret,
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
  return next;
}

export function asanaAccessToken(override?: string, config = loadAsanaDesk()): string {
  return override?.trim() || config.asanaToken || process.env.ASANA_ACCESS_TOKEN?.trim() || "";
}

export function sailPointClientForDesk(config = loadAsanaDesk()) {
  if (config.clientId && config.clientSecret && config.tenant) {
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
    doneStatus: text(config.doneStatus, defaults.doneStatus),
    accountField: text(config.accountField, defaults.accountField),
    codeField: text(config.codeField, defaults.codeField),
    tenantLinkField: config.tenantLinkField?.trim() ?? "",
    tenantLinkTemplate: text(config.tenantLinkTemplate, defaults.tenantLinkTemplate),
  };
}

function deskPath(): string {
  return path.join(resolveAgentForgeDataDir(), "readonly-account-asana-desk.json");
}
