import fs from "fs";
import path from "path";

import {
  DEPLOYMENT_PROVIDERS,
  DEPLOYMENT_PROVIDER_VALUES,
  type DeploymentProvider,
} from "@/lib/providers/profiles";
import { resolveAgentForgeDataDir } from "@/lib/db/store";
import { formatIscTenantUrl } from "@/lib/isc/tenant-url";

const DATA_DIR = resolveAgentForgeDataDir();
const SETTINGS_PATH = path.join(DATA_DIR, "isc-settings.json");

export type IscPlatformSources = Record<DeploymentProvider, string>;
export type IscPlatformMisSchemas = Record<DeploymentProvider, string>;

export interface IscStoredCredentials {
  tenant: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
  domain: string;
}

export interface IscSettingsFile {
  credentials?: IscStoredCredentials;
  sources: IscPlatformSources;
  misSchemas: IscPlatformMisSchemas;
  updatedAt: string;
}

function emptySources(): IscPlatformSources {
  return {
    aws_bedrock: "",
    gcp_vertex: "",
    azure_ai_foundry: "",
  };
}

function defaultMisSchemas(): IscPlatformMisSchemas {
  return {
    aws_bedrock: DEPLOYMENT_PROVIDERS.aws_bedrock.misSchemaId,
    gcp_vertex: DEPLOYMENT_PROVIDERS.gcp_vertex.misSchemaId,
    azure_ai_foundry: DEPLOYMENT_PROVIDERS.azure_ai_foundry.misSchemaId,
  };
}

function normalizePlatformStrings(
  values: Partial<Record<DeploymentProvider, string>> | undefined,
  defaults: Record<DeploymentProvider, string>,
): Record<DeploymentProvider, string> {
  const base = { ...defaults };
  if (!values) {
    return base;
  }

  for (const provider of DEPLOYMENT_PROVIDER_VALUES) {
    const value = values[provider];
    if (typeof value === "string") {
      base[provider] = value.trim();
    }
  }

  return base;
}

/** One-time migration for deployments that still have source IDs in env. */
function migrateFromEnvIfNeeded(settings: IscSettingsFile): IscSettingsFile {
  let changed = false;

  const envByProvider: Record<DeploymentProvider, readonly string[]> = {
    aws_bedrock: ["ISC_SOURCE_ID_AWS_BEDROCK", "ISC_SOURCE_ID"],
    gcp_vertex: ["ISC_SOURCE_ID_GCP_VERTEX"],
    azure_ai_foundry: ["ISC_SOURCE_ID_AZURE_FOUNDRY"],
  };

  const sources = { ...settings.sources };

  for (const provider of DEPLOYMENT_PROVIDER_VALUES) {
    if (sources[provider]) {
      continue;
    }

    for (const key of envByProvider[provider]) {
      const value = process.env[key]?.trim();
      if (value) {
        sources[provider] = value;
        changed = true;
        break;
      }
    }
  }

  const misSchemas = { ...settings.misSchemas };
  const misEnvByProvider: Record<DeploymentProvider, readonly string[]> = {
    aws_bedrock: ["ISC_MIS_DATASET_IDS_BEDROCK", "ISC_MIS_DATASET_IDS"],
    gcp_vertex: ["ISC_MIS_DATASET_IDS_GCP_VERTEX"],
    azure_ai_foundry: ["ISC_MIS_DATASET_IDS_AZURE_FOUNDRY"],
  };

  for (const provider of DEPLOYMENT_PROVIDER_VALUES) {
    const current = misSchemas[provider];
    const isDefault = current === DEPLOYMENT_PROVIDERS[provider].misSchemaId;
    if (current && !isDefault) {
      continue;
    }

    for (const key of misEnvByProvider[provider]) {
      const value = process.env[key]?.split(",")[0]?.trim();
      if (value) {
        misSchemas[provider] = value;
        changed = true;
        break;
      }
    }
  }

  if (!changed) {
    return settings;
  }

  const migrated: IscSettingsFile = {
    ...settings,
    sources,
    misSchemas,
    updatedAt: new Date().toISOString(),
  };
  writeSettingsFile(migrated);
  return migrated;
}

function writeSettingsFile(settings: IscSettingsFile) {
  cachedSettings = settings;

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.warn(
      `Failed to persist ISC settings at ${SETTINGS_PATH}; using in-memory cache for this instance.`,
      error,
    );
  }
}

let cachedSettings: IscSettingsFile | null = null;

function loadSettingsFromDisk(): IscSettingsFile {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(SETTINGS_PATH)) {
    const initial: IscSettingsFile = {
      sources: emptySources(),
      misSchemas: defaultMisSchemas(),
      updatedAt: new Date().toISOString(),
    };
    writeSettingsFile(initial);
    return migrateFromEnvIfNeeded(initial);
  }

  const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
  const parsed = JSON.parse(raw) as Partial<IscSettingsFile>;
  const settings: IscSettingsFile = {
    credentials: parsed.credentials,
    sources: normalizePlatformStrings(parsed.sources, emptySources()) as IscPlatformSources,
    misSchemas: normalizePlatformStrings(
      parsed.misSchemas,
      defaultMisSchemas(),
    ) as IscPlatformMisSchemas,
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
  };

  return migrateFromEnvIfNeeded(settings);
}

export function readIscSettings(): IscSettingsFile {
  if (cachedSettings) {
    return cachedSettings;
  }

  cachedSettings = loadSettingsFromDisk();
  return cachedSettings;
}

export function getIscSourceId(provider: DeploymentProvider): string | null {
  const value = readIscSettings().sources[provider]?.trim();
  return value || null;
}

export function getMisSchemaId(provider: DeploymentProvider): string {
  const value = readIscSettings().misSchemas[provider]?.trim();
  if (value) {
    return value;
  }

  return DEPLOYMENT_PROVIDERS[provider].misSchemaId;
}

/** Alias — stored value is the ISC dataset id (legacy name: MIS schema). */
export function getDatasetId(provider: DeploymentProvider): string {
  return getMisSchemaId(provider);
}

export function getConfiguredIscSourceIds(): Record<
  DeploymentProvider,
  string | null
> {
  const sources = readIscSettings().sources;
  return {
    aws_bedrock: sources.aws_bedrock || null,
    gcp_vertex: sources.gcp_vertex || null,
    azure_ai_foundry: sources.azure_ai_foundry || null,
  };
}

export function getStoredIscCredentials(): IscStoredCredentials | null {
  const credentials = readIscSettings().credentials;
  if (
    !credentials?.tenant?.trim() ||
    !credentials.clientId?.trim() ||
    !credentials.clientSecret?.trim()
  ) {
    return null;
  }

  return {
    tenant: credentials.tenant.trim(),
    clientId: credentials.clientId.trim(),
    clientSecret: credentials.clientSecret.trim(),
    apiVersion: credentials.apiVersion?.trim() || "v2026",
    domain: credentials.domain?.trim() || "identitynow.com",
  };
}

export function getIscCredentialsPublicView() {
  const stored = readIscSettings().credentials;
  const hasStored =
    Boolean(stored?.tenant?.trim()) &&
    Boolean(stored?.clientId?.trim()) &&
    Boolean(stored?.clientSecret?.trim());

  if (hasStored && stored) {
    const domain = stored.domain?.trim() || "identitynow.com";
    const tenant = stored.tenant.trim();
    return {
      configured: true,
      tenant,
      clientId: stored.clientId.trim(),
      clientSecretSet: true,
      apiVersion: stored.apiVersion?.trim() || "v2026",
      domain,
      tenantUrl: formatIscTenantUrl(tenant, domain),
      source: "ui" as const,
    };
  }

  const tenant = process.env.ISC_TENANT?.trim();
  const clientId = process.env.ISC_CLIENT_ID?.trim();
  const clientSecret = process.env.ISC_CLIENT_SECRET?.trim();

  if (tenant && clientId && clientSecret) {
    const domain = process.env.ISC_DOMAIN?.trim() || "identitynow.com";
    return {
      configured: true,
      tenant,
      clientId,
      clientSecretSet: true,
      apiVersion: process.env.ISC_API_VERSION?.trim() || "v2026",
      domain,
      tenantUrl: formatIscTenantUrl(tenant, domain),
      source: "env" as const,
    };
  }

  const partialDomain =
    stored?.domain?.trim() ||
    process.env.ISC_DOMAIN?.trim() ||
    "identitynow.com";
  const partialTenant =
    stored?.tenant?.trim() ?? tenant ?? null;

  return {
    configured: false,
    tenant: partialTenant,
    clientId: stored?.clientId?.trim() ?? clientId ?? null,
    clientSecretSet: Boolean(stored?.clientSecret?.trim() || clientSecret),
    apiVersion:
      stored?.apiVersion?.trim() ||
      process.env.ISC_API_VERSION?.trim() ||
      "v2026",
    domain: partialDomain,
    tenantUrl: partialTenant
      ? formatIscTenantUrl(partialTenant, partialDomain)
      : null,
    source: null as "ui" | "env" | null,
  };
}

export function updateIscCredentials(
  patch: {
    tenant: string;
    clientId: string;
    clientSecret?: string;
    apiVersion?: string;
    domain?: string;
  },
): IscSettingsFile {
  const current = readIscSettings();
  const existingSecret = current.credentials?.clientSecret?.trim() ?? "";
  const nextSecret = patch.clientSecret?.trim() || existingSecret;

  if (!nextSecret) {
    throw new Error("Client secret is required");
  }

  const next: IscSettingsFile = {
    ...current,
    credentials: {
      tenant: patch.tenant.trim(),
      clientId: patch.clientId.trim(),
      clientSecret: nextSecret,
      apiVersion: patch.apiVersion?.trim() || "v2026",
      domain: patch.domain?.trim() || "identitynow.com",
    },
    updatedAt: new Date().toISOString(),
  };

  writeSettingsFile(next);
  return next;
}

export function updateIscSettings(patch: {
  sources?: Partial<Record<DeploymentProvider, string>>;
  misSchemas?: Partial<Record<DeploymentProvider, string>>;
}): IscSettingsFile {
  const current = readIscSettings();
  const sources = { ...current.sources };
  const misSchemas = { ...current.misSchemas };

  if (patch.sources) {
    for (const provider of DEPLOYMENT_PROVIDER_VALUES) {
      if (provider in patch.sources) {
        sources[provider] = patch.sources[provider]?.trim() ?? "";
      }
    }
  }

  if (patch.misSchemas) {
    for (const provider of DEPLOYMENT_PROVIDER_VALUES) {
      if (provider in patch.misSchemas) {
        misSchemas[provider] =
          patch.misSchemas[provider]?.trim() ||
          DEPLOYMENT_PROVIDERS[provider].misSchemaId;
      }
    }
  }

  const next: IscSettingsFile = {
    ...current,
    credentials: current.credentials,
    sources,
    misSchemas,
    updatedAt: new Date().toISOString(),
  };
  writeSettingsFile(next);
  return next;
}

/** @deprecated Use updateIscSettings */
export function updateIscPlatformSources(
  patch: Partial<Record<DeploymentProvider, string>>,
): IscSettingsFile {
  return updateIscSettings({ sources: patch });
}
