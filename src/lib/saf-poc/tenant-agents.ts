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

export type AgentFinding = {
  title: string;
  detectedAt: string;
};

export type AgentRiskSnapshot = {
  calculatedSeverity: string;
  findings: AgentFinding[];
  findingsNote: string;
};

export type AgentRiskInputs = {
  agentId: string;
  name: string;
  modified: string;
  score: number | null;
  severity: string;
  owners: Record<string, unknown>;
  userEntitlements: unknown[];
  businessApplicationRefs: unknown[];
  effectiveSanctionedStatus: string;
  sourceId: string;
  resourceId: string;
  datasetId: string;
  ownershipCorrelationConfigs: unknown[];
};

export function parseAgentFindings(records: unknown[]): AgentFinding[] {
  return records.flatMap((record) => {
    const finding = parseAgentFinding(record);
    return finding ? [finding] : [];
  });
}

export async function readAgentRiskSnapshot(
  agentId: string,
  config: SailPointSetupConfig = loadSafPocConfig(),
  fetchImpl?: FetchLike,
): Promise<AgentRiskSnapshot> {
  const client = createSailPointClient(config, fetchImpl);
  const identity = await readMachineIdentity(client, agentId);
  const agent = identity ? parseTenantAgent(identity) : null;
  let findings: AgentFinding[] = [];
  let findingsNote = "";
  try {
    const payload = await client.request(
      "GET",
      `/machine-identities/v1/${encodeURIComponent(agentId)}/anomalies`,
      undefined,
      "application/json",
      EXPERIMENTAL_HEADER,
    );
    findings = parseAgentFindings(unwrapList(payload));
  } catch (error) {
    if (!(error instanceof SailPointApiError) || (error.status !== 404 && error.status !== 403)) {
      throw error;
    }
    findingsNote = "SailPoint did not return the anomalies list for this agent.";
  }
  findings = mergeFindings(parseAgentFindings(collectFindingRecords(identity)), findings);
  if (findings.length === 0 && !findingsNote) {
    findingsNote = "SailPoint returned no findings for this agent.";
  }
  return {
    calculatedSeverity: agent?.riskLevel || "Unavailable",
    findings,
    findingsNote,
  };
}

export async function readAgentRiskInputs(
  agentId: string,
  config: SailPointSetupConfig = loadSafPocConfig(),
  fetchImpl?: FetchLike,
): Promise<AgentRiskInputs> {
  const client = createSailPointClient(config, fetchImpl);
  const encoded = encodeURIComponent(agentId);
  const identity = asRecord(
    await client.request(
      "GET",
      `/machine-identities/v2/${encoded}`,
      undefined,
      "application/json",
      EXPERIMENTAL_HEADER,
    ),
  );
  if (!identity) {
    throw new Error(`Machine identity ${agentId} did not return a v2 record.`);
  }
  const risk = asRecord(identity.risk);
  const source = asRecord(identity.source);
  const resource = asRecord(identity.resource);
  const sourceId = text(identity.sourceId) || text(source?.id);
  const resourceId = text(resource?.id);
  let ownershipCorrelationConfigs: unknown[] = [];
  if (sourceId && resourceId) {
    try {
      const configs = await client.request(
        "GET",
        `/sources/v1/${encodeURIComponent(sourceId)}/resources/${encodeURIComponent(resourceId)}/correlation-configs?type=OWNER_PRIMARY`,
        undefined,
        "application/json",
        EXPERIMENTAL_HEADER,
      );
      ownershipCorrelationConfigs = unwrapList(configs);
    } catch (error) {
      if (!(error instanceof SailPointApiError) || ![403, 404].includes(error.status)) {
        throw error;
      }
    }
  }
  return {
    agentId,
    name: text(identity.name) || text(identity.displayName) || agentId,
    modified: text(identity.modified),
    score: typeof risk?.score === "number" ? risk.score : null,
    severity: knownRiskLevel(text(risk?.severity)) || "Unavailable",
    owners: asRecord(identity.owners) ?? {},
    userEntitlements: Array.isArray(identity.userEntitlements)
      ? identity.userEntitlements
      : [],
    businessApplicationRefs: Array.isArray(identity.businessApplicationRefs)
      ? identity.businessApplicationRefs
      : [],
    effectiveSanctionedStatus: text(identity.effectiveSanctionedStatus),
    sourceId,
    resourceId,
    datasetId: text(identity.datasetId),
    ownershipCorrelationConfigs,
  };
}

export async function patchAgentRiskInputs(
  agentId: string,
  changes: {
    owners?: Record<string, unknown>;
    userEntitlements?: unknown[];
    businessApplicationRefs?: unknown[];
  },
  config: SailPointSetupConfig = loadSafPocConfig(),
  fetchImpl?: FetchLike,
): Promise<void> {
  const patch = Object.entries(changes).map(([path, value]) => ({
    op: "replace",
    path: `/${path}`,
    value,
  }));
  if (patch.length === 0) {
    return;
  }
  const client = createSailPointClient(config, fetchImpl);
  await client.request(
    "PATCH",
    `/machine-identities/v2/${encodeURIComponent(agentId)}`,
    patch,
    "application/json-patch+json",
    EXPERIMENTAL_HEADER,
  );
}

export async function aggregateAgentRiskInputs(
  sourceId: string,
  datasetId: string,
  config: SailPointSetupConfig = loadSafPocConfig(),
  fetchImpl?: FetchLike,
): Promise<void> {
  if (!sourceId || !datasetId) {
    throw new Error("The machine identity did not return a source and dataset ID.");
  }
  const client = createSailPointClient(config, fetchImpl);
  await client.request(
    "POST",
    `/sources/v1/${encodeURIComponent(sourceId)}/datasets/${encodeURIComponent(datasetId)}/aggregate`,
    undefined,
    "application/json",
    EXPERIMENTAL_HEADER,
  );
}

async function readMachineIdentity(
  client: ReturnType<typeof createSailPointClient>,
  agentId: string,
): Promise<unknown> {
  const encoded = encodeURIComponent(agentId);
  for (const requestPath of [
    `/machine-identities/v1/${encoded}`,
    `/v2026/machine-identities/${encoded}`,
  ]) {
    try {
      return await client.request(
        "GET",
        requestPath,
        undefined,
        "application/json",
        EXPERIMENTAL_HEADER,
      );
    } catch (error) {
      if (!(error instanceof SailPointApiError) || error.status !== 404) {
        throw error;
      }
    }
  }
  return null;
}

export function emailAddress(value: string): string {
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

export async function resolveAgentOwnerEmail(
  agent: TenantAgent,
  config: SailPointSetupConfig = loadSafPocConfig(),
  fetchImpl?: FetchLike,
): Promise<string> {
  const direct = emailAddress(agent.ownerEmail);
  if (direct) {
    return direct;
  }
  const client = createSailPointClient(config, fetchImpl);
  const paths = agent.ownerId
    ? [
        `/identities/v1/${encodeURIComponent(agent.ownerId)}`,
        `/v3/identities/${encodeURIComponent(agent.ownerId)}`,
      ]
    : [];
  for (const requestPath of paths) {
    const email = await readIdentityEmail(() =>
      client.request("GET", requestPath, undefined, "application/json"),
    );
    if (email) {
      return email;
    }
  }
  const ownerName = agent.ownerName.replaceAll('"', "").trim();
  if (!ownerName) {
    return "";
  }
  const filter = encodeURIComponent(`alias eq "${ownerName}" or name eq "${ownerName}"`);
  for (const requestPath of [
    `/v3/public-identities?filters=${filter}`,
    `/v3/identities?filters=${filter}`,
  ]) {
    const email = await readIdentityEmail(() => client.listRecords(requestPath));
    if (email) {
      return email;
    }
  }
  return readIdentityEmail(() =>
    client.request("POST", "/v3/search", {
      indices: ["identities"],
      query: { query: `alias:${ownerName} OR name:"${ownerName}"` },
      sort: ["name"],
    }),
  );
}

function parseAgentFinding(value: unknown): AgentFinding | null {
  if (typeof value === "string" && value.trim()) {
    return { title: value.trim(), detectedAt: "" };
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const nested = asRecord(record.details) || asRecord(record.insight) || asRecord(record.finding);
  const title =
    findingTitle(record) ||
    (nested ? findingTitle(nested) : "");
  if (!title) {
    return null;
  }
  return {
    title,
    detectedAt: findingTime(record) || (nested ? findingTime(nested) : ""),
  };
}

function findingTitle(record: Record<string, unknown>): string {
  return (
    text(record.title) ||
    text(record.name) ||
    text(record.displayName) ||
    text(record.summary) ||
    text(record.message) ||
    text(record.label) ||
    text(record.reason) ||
    text(record.factor) ||
    text(record.anomalyType) ||
    humanizeToken(text(record.type) || text(record.code)) ||
    text(record.description)
  );
}

function findingTime(record: Record<string, unknown>): string {
  return (
    text(record.detectedAt) ||
    text(record.detected) ||
    text(record.firstDetectedAt) ||
    text(record.firstSeen) ||
    text(record.lastDetected) ||
    text(record.detectedDate) ||
    text(record.created) ||
    text(record.createdAt) ||
    text(record.timestamp)
  );
}

function humanizeToken(value: string): string {
  if (
    !value ||
    value.includes(" ") ||
    /^[0-9a-f-]{16,}$/i.test(value) ||
    ["low", "medium", "high", "critical", "unknown", "benign"].includes(value.toLowerCase())
  ) {
    return "";
  }
  return value
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function collectFindingRecords(payload: unknown): unknown[] {
  const record = asRecord(payload);
  if (!record) {
    return unwrapList(payload);
  }
  const risk = asRecord(record.risk);
  return [
    ...recordsFrom(record.insights),
    ...recordsFrom(record.findings),
    ...recordsFrom(record.anomalies),
    ...recordsFrom(risk?.findings),
    ...recordsFrom(risk?.insights),
    ...recordsFrom(risk?.factors),
  ];
}

function recordsFrom(value: unknown): unknown[] {
  const listed = unwrapList(value);
  if (listed.length > 0) {
    return listed;
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  return Object.entries(record).flatMap(([key, entry]) => {
    if (entry === true) {
      const title = humanizeToken(key);
      return title ? [{ title }] : [];
    }
    const child = asRecord(entry);
    if (!child || (!findingTitle(child) && !findingTime(child))) {
      return [];
    }
    return [child.title || child.name || child.displayName ? child : { ...child, title: humanizeToken(key) }];
  });
}

function mergeFindings(primary: AgentFinding[], extra: AgentFinding[]): AgentFinding[] {
  const seen = new Set(primary.map((finding) => finding.title.toLowerCase()));
  return [
    ...primary,
    ...extra.filter((finding) => {
      const key = finding.title.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }),
  ];
}

function unwrapList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = asRecord(payload);
  if (!record) {
    return [];
  }
  for (const key of ["items", "anomalies", "findings", "insights", "factors", "data", "results", "content", "records"]) {
    if (Array.isArray(record[key])) {
      return record[key];
    }
  }
  return [];
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

async function readIdentityEmail(load: () => Promise<unknown>): Promise<string> {
  try {
    return emailFromIdentity(await load());
  } catch (error) {
    if (error instanceof SailPointApiError && (error.status === 401 || error.status >= 500)) {
      throw error;
    }
    return "";
  }
}

function emailFromIdentity(value: unknown): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const email = emailFromIdentity(item);
      if (email) {
        return email;
      }
    }
    return "";
  }
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  const attributes = asRecord(record.attributes);
  const items = record.items;
  return (
    emailAddress(text(record.email)) ||
    emailAddress(text(record.alias)) ||
    emailAddress(text(attributes?.email)) ||
    emailAddress(text(attributes?.workEmail)) ||
    emailAddress(text(attributes?.mail)) ||
    (Array.isArray(items) ? emailFromIdentity(items) : "")
  );
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
