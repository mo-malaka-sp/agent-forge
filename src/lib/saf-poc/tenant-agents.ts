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
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
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

export async function resolveAgentOwnerEmail(
  agent: TenantAgent,
  config: SailPointSetupConfig = loadSafPocConfig(),
  fetchImpl?: FetchLike,
): Promise<string> {
  if (agent.ownerEmail) {
    return agent.ownerEmail.toLowerCase();
  }
  if (!agent.ownerId) {
    return "";
  }
  const client = createSailPointClient(config, fetchImpl);
  for (const requestPath of [
    `/identities/v1/${encodeURIComponent(agent.ownerId)}`,
    `/v3/identities/${encodeURIComponent(agent.ownerId)}`,
  ]) {
    try {
      const identity = await client.request("GET", requestPath, undefined, "application/json");
      const email = emailFromIdentity(identity);
      if (email) {
        return email;
      }
    } catch (error) {
      if (!(error instanceof SailPointApiError) || error.status !== 404) {
        throw error;
      }
    }
  }
  return "";
}

export async function updateTenantAgentRisk(
  agentId: string,
  riskLevel: string,
  config: SailPointSetupConfig = loadSafPocConfig(),
  fetchImpl?: FetchLike,
): Promise<string> {
  const client = createSailPointClient(config, fetchImpl);
  const value = riskLevel.toUpperCase();
  const attempts = [
    [{ op: "replace", path: "/risk/severity", value }],
    [{ op: "replace", path: "/attributes/riskLevel", value }],
  ];
  let lastError: unknown;
  for (const body of attempts) {
    try {
      await client.request(
        "PATCH",
        `/machine-identities/v1/${encodeURIComponent(agentId)}`,
        body,
        "application/json-patch+json",
        EXPERIMENTAL_HEADER,
      );
      return `SailPoint stored ${value} on the agent.`;
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof SailPointApiError) ||
        (error.status !== 400 && error.status !== 404 && error.status !== 422)
      ) {
        throw error;
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : "SailPoint rejected the risk update.";
  return `SailPoint did not store the risk on the agent. ${detail}`;
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
  const owner = primaryOwner(record);
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
    ownerId: owner.id,
    ownerName: owner.name,
    ownerEmail: owner.email,
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

function primaryOwner(record: Record<string, unknown>): {
  id: string;
  name: string;
  email: string;
} {
  const owners = asRecord(record.owners);
  const primary =
    asRecord(owners?.primaryIdentity) ||
    asRecord(owners?.primary) ||
    asRecord(record.owner);
  return {
    id: text(primary?.id),
    name: text(primary?.name) || text(primary?.displayName),
    email: emailFromIdentity(primary),
  };
}

function emailFromIdentity(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  const attributes = asRecord(record.attributes);
  return (
    text(record.email) ||
    text(record.alias) ||
    text(attributes?.email) ||
    text(attributes?.workEmail) ||
    text(attributes?.mail)
  ).toLowerCase();
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
