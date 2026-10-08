import { loadSafPocConfig } from "@/lib/saf-poc/config";
import {
  createSailPointClient,
  SailPointApiError,
  type SailPointSetupConfig,
} from "@/lib/saf-poc/sailpoint";

export type TenantAgent = {
  id: string;
  name: string;
  riskLevel: string;
  email: string;
  source: string;
  subtype: string;
};

const MACHINE_IDENTITY_PATHS = [
  "/machine-identities/v1",
  "/v2026/machine-identities",
] as const;
const EXPERIMENTAL_HEADER = { "X-SailPoint-Experimental": "true" };

type FetchLike = typeof fetch;

export function parseTenantAgents(records: unknown[]): TenantAgent[] {
  return records.flatMap((record) => {
    const agent = parseTenantAgent(record);
    return agent ? [agent] : [];
  });
}

export function selectTenantAgents(agents: TenantAgent[]): TenantAgent[] {
  const marked = agents.filter((agent) => /agent/i.test(agent.subtype));
  return marked.length > 0 ? marked : agents;
}

export async function listTenantAgents(
  config: SailPointSetupConfig = loadSafPocConfig(),
  fetchImpl?: FetchLike,
): Promise<TenantAgent[]> {
  const client = createSailPointClient(config, fetchImpl);
  let lastError: unknown;
  for (const requestPath of MACHINE_IDENTITY_PATHS) {
    try {
      const records = await client.listRecords(requestPath, EXPERIMENTAL_HEADER);
      return selectTenantAgents(parseTenantAgents(records));
    } catch (error) {
      lastError = error;
      if (!(error instanceof SailPointApiError) || error.status !== 404) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("SailPoint did not return machine identities.");
}

function parseTenantAgent(value: unknown): TenantAgent | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const attributes = asRecord(record.attributes) ?? {};
  const risk = asRecord(record.risk);
  const id = text(record.id);
  const name =
    text(record.displayName) ||
    text(record.name) ||
    text(record.nativeIdentity) ||
    text(record.businessApplication) ||
    text(attributes.displayName) ||
    text(attributes.name);
  if (!id || !name) {
    return null;
  }
  const source = asRecord(record.source);
  return {
    id,
    name,
    riskLevel: knownRiskLevel(
      text(risk?.severity) ||
        text(record.riskLevel) ||
        text(attributes.riskLevel) ||
        text(attributes.risk_level) ||
        text(attributes.risk),
    ),
    email:
      text(record.email) ||
      text(attributes.email) ||
      text(attributes.identityEmail) ||
      text(attributes.mail),
    source: text(source?.name),
    subtype:
      text(record.subtype) ||
      text(record.subType) ||
      text(record.identitySubtype) ||
      text(attributes.subtype) ||
      text(attributes.subType) ||
      text(attributes.type),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function knownRiskLevel(level: string): string {
  const normalized = level.toLowerCase();
  if (!["low", "medium", "high", "critical"].includes(normalized)) {
    return "";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
