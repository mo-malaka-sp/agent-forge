/**
 * Types and constants for saved tenant profiles. Safe to import from client components.
 * The server store lives in `profiles-store.ts`.
 */

/** Features that can each point at their own saved tenant. "default" covers everything else. */
export const TENANT_FEATURES = [
  "default",
  "test-drive",
  "caep",
  "datadog",
  "endpoint",
  "ask",
  "govern",
] as const;

export type TenantFeature = (typeof TENANT_FEATURES)[number];

export const TENANT_FEATURE_LABELS: Record<TenantFeature, string> = {
  default: "Default (anything not assigned)",
  "test-drive": "SAF TestDrive Accounts",
  caep: "CAEP event bus",
  datadog: "Datadog security signals",
  endpoint: "Endpoint agent risk",
  ask: "Ask this tenant",
  govern: "Govern and environments",
};

export const TENANT_SOURCE_PROVIDERS = ["aws_bedrock", "gcp_vertex", "azure_ai_foundry"] as const;

export type TenantSources = Partial<Record<(typeof TENANT_SOURCE_PROVIDERS)[number], string>>;

export type TenantTestResult = { ok: boolean; summary: string; at: string };

export type IscProfilePublic = {
  id: string;
  name: string;
  tenant: string;
  domain: string;
  apiVersion: string;
  clientId: string;
  clientSecretSet: boolean;
  sources: TenantSources;
  passwordClientId: string;
  passwordClientSecretSet: boolean;
  ownerId: string;
  ownerName: string;
  triggerName: string;
  notifyEmail: string;
  lastTest: TenantTestResult | null;
  tenantUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type IscBindings = Partial<Record<TenantFeature, string | null>>;

export type ConnectionStep = {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
  detail: string;
};

export type ConnectionCheck = {
  ok: boolean;
  host: string;
  steps: ConnectionStep[];
  checkedAt: string;
};
