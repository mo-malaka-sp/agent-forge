import { iscRequest } from "@/lib/isc/client";
import { getIscCredentials, type IscCredentials } from "@/lib/isc/config";
import { listSafEvents } from "@/lib/saf-poc/events";
import {
  listTenantAgents,
  readAgentRiskSnapshot,
  type AgentRiskSnapshot,
  type TenantAgent,
} from "@/lib/saf-poc/tenant-agents";

export const ROW_LIMIT = 25;
const AGENT_CANDIDATE_LIMIT = 5;

export const ASK_TOOL_NAMES = [
  "search_identities",
  "search_access",
  "search_audit_events",
  "list_saf_events",
  "list_agents",
  "describe_agent",
] as const;

/** Fallback when a question matches no topic. describe_agent is excluded — it is
 * narrow and costs one SailPoint call per candidate agent, so it only runs when
 * the question names a capability, finding, or feature. */
const DEFAULT_TOOLS: AskToolName[] = [
  "search_identities",
  "search_access",
  "search_audit_events",
  "list_saf_events",
  "list_agents",
];

export type AskToolName = (typeof ASK_TOOL_NAMES)[number];

export interface SafEventInput {
  id: string;
  receivedAt: string;
  event: {
    tenant: string;
    eventType: string;
    identity: { name: string };
    agent: { name?: string };
    risk: { severity: string; status: string; title: string };
  };
}

export interface AskDeps {
  tenant: string | null;
  search: (indices: string[], query: string) => Promise<unknown[]>;
  safEvents: () => Promise<SafEventInput[]>;
  listAgents: () => Promise<TenantAgent[]>;
  agentFindings: (agentId: string) => Promise<AgentRiskSnapshot>;
}

export interface AskRead {
  tool: AskToolName;
  label: string;
  query: string;
  tenant: string | null;
  rows: Record<string, unknown>[];
  truncated: boolean;
  error?: string;
}

export interface AskAnswer {
  tenant: string | null;
  refused: boolean;
  answer: string;
  reads: AskRead[];
}

const WRITE_REQUEST =
  /\b(insert|update|delete|drop|alter|truncate|merge|grant|revoke|create|disable|enable|invite|provision|deprovision|assign)\b/i;

const TOPIC_RULES: Array<{ tool: AskToolName; pattern: RegExp }> = [
  { tool: "list_saf_events", pattern: /\b(saf|caep|datadog|execution|agent risk|risk signal)\b/i },
  { tool: "search_audit_events", pattern: /\b(audit|event|events|activity|changed|change|happened|latest|recent|log|logs)\b/i },
  { tool: "search_access", pattern: /\b(access|entitlement|entitlements|role|roles|permission|permissions|profile)\b/i },
  { tool: "search_identities", pattern: /\b(identity|identities|user|users|person|people|account|accounts|who)\b/i },
  { tool: "list_agents", pattern: /\b(agents?|machine identit(?:y|ies))\b/i },
  {
    tool: "describe_agent",
    pattern: /\b(capabilit(?:y|ies)|findings?|anomal(?:y|ies)|features?)\b/i,
  },
];

const STOP_WORDS = new Set([
  "what", "which", "who", "whom", "whose", "where", "when", "why", "how",
  "the", "and", "for", "with", "from", "that", "this", "about", "have", "has",
  "does", "did", "show", "list", "tell", "give", "recent", "latest", "happened",
  "please", "tenant", "access", "identity", "identities", "user", "users",
  "named", "called", "find", "looking", "into", "me", "log", "logs",
  "signal", "signals", "activity", "profile", "permission", "permissions",
  "execution",
  "account", "accounts", "event", "events", "audit", "role", "roles",
  "entitlement", "entitlements", "saf", "caep", "datadog", "agent", "agents",
  "risk", "connected", "there", "their", "them", "any", "are", "was", "were",
  "machine", "capability", "capabilities", "finding", "findings",
  "anomaly", "anomalies", "feature", "features",
  "use", "using", "used", "owned",
]);

const TOOL_LABELS: Record<AskToolName, string> = {
  search_identities: "Identities",
  search_access: "Access",
  search_audit_events: "Audit events",
  list_saf_events: "SAF events",
  list_agents: "SAF agents",
  describe_agent: "Agent findings",
};

const TOOL_INDICES: Record<"search_identities" | "search_access" | "search_audit_events", string[]> = {
  search_identities: ["identities"],
  search_access: ["entitlements", "roles", "accessprofiles"],
  search_audit_events: ["events"],
};

export function isWriteRequest(value: string): boolean {
  return WRITE_REQUEST.test(value);
}

export function toolsForQuestion(question: string): AskToolName[] {
  const matched = TOPIC_RULES.filter((rule) => rule.pattern.test(question)).map((rule) => rule.tool);
  return matched.length > 0 ? matched : [...DEFAULT_TOOLS];
}

export function searchText(question: string): string {
  const quoted = question.match(/"([^"]{1,80})"/);
  if (quoted?.[1]) {
    return quoted[1];
  }
  const email = question.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email) {
    return email[0];
  }
  const tokens = question
    .replace(/[^A-Za-z0-9@.+_-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token.toLowerCase()));
  if (tokens.length === 0) {
    return "*";
  }
  return tokens.slice(0, 4).join(" ");
}

export function tenantLine(tenant: string | null): string {
  return tenant ? `On tenant ${tenant}.` : "No ISC tenant is connected.";
}

function writeReason(tenant: string | null): string {
  return tenant
    ? `Only read-only questions are allowed on tenant ${tenant}.`
    : "Only read-only questions are allowed.";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function personName(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return text(record.displayName) ?? text(record.name);
}

function slimIdentity(row: unknown): Record<string, unknown> {
  const record = asRecord(row) ?? {};
  const attributes = asRecord(record.attributes);
  return {
    id: text(record.id),
    name: text(record.name),
    displayName: text(record.displayName),
    email: text(record.email) ?? text(attributes?.email),
    identityStatus: text(record.identityStatus) ?? text(record.status),
  };
}

function slimAccess(row: unknown): Record<string, unknown> {
  const record = asRecord(row) ?? {};
  const source = asRecord(record.source);
  return {
    id: text(record.id),
    name: text(record.name) ?? text(record.displayName),
    description: text(record.description),
    source: text(source?.name),
    type: text(record.type) ?? text(record.objectType),
  };
}

function slimAudit(row: unknown): Record<string, unknown> {
  const record = asRecord(row) ?? {};
  return {
    id: text(record.id),
    created: text(record.created) ?? text(record.createdAt) ?? text(record.timestamp),
    action: text(record.action) ?? text(record.name) ?? text(record.type),
    status: text(record.status),
    actor: personName(record.actor) ?? personName(record.user),
    target: personName(record.target) ?? text(record.target),
  };
}

function slimAgent(agent: TenantAgent): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    riskLevel: agent.riskLevel || undefined,
    source: agent.source || undefined,
    agentType: agent.agentType || agent.subtype || undefined,
    businessApplication: agent.businessApplication || undefined,
    owner: agent.ownerName || undefined,
  };
}

function matchingAgents(agents: TenantAgent[], query: string): TenantAgent[] {
  const sorted = [...agents].sort((left, right) => left.name.localeCompare(right.name));
  if (query === "*") {
    return sorted;
  }
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return sorted.filter((agent) => {
    const haystack = [
      agent.name,
      agent.id,
      agent.source,
      agent.agentType,
      agent.subtype,
      agent.businessApplication,
      agent.ownerName,
      agent.riskLevel,
    ]
      .join(" ")
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function slimSaf(event: SafEventInput): Record<string, unknown> {
  return {
    id: event.id,
    receivedAt: event.receivedAt,
    tenant: event.event.tenant,
    eventType: event.event.eventType,
    identity: event.event.identity.name,
    agent: event.event.agent.name,
    severity: event.event.risk.severity,
    status: event.event.risk.status,
    title: event.event.risk.title,
  };
}

function rowLine(tool: AskToolName, row: Record<string, unknown>): string {
  if (tool === "search_identities") {
    const name = text(row.displayName) ?? text(row.name) ?? text(row.id) ?? "Identity";
    const email = text(row.email);
    return email ? `${name} <${email}>` : name;
  }
  if (tool === "search_access") {
    const name = text(row.name) ?? text(row.id) ?? "Access";
    const source = text(row.source);
    return source ? `${name} (${source})` : name;
  }
  if (tool === "search_audit_events") {
    const action = text(row.action) ?? "event";
    const actor = text(row.actor);
    const created = text(row.created);
    return [action, actor ? `by ${actor}` : "", created ? `at ${created}` : ""].filter(Boolean).join(" ");
  }
  if (tool === "list_agents") {
    const name = text(row.name) ?? text(row.id) ?? "Agent";
    const risk = text(row.riskLevel) ?? "Unknown";
    const source = text(row.source);
    const owner = text(row.owner);
    return [
      `${name} — ${risk} risk`,
      source ? `(${source})` : "",
      owner ? `owner ${owner}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (tool === "describe_agent") {
    const agent = text(row.agent) ?? "Agent";
    const severity = text(row.severity) ?? "Unknown";
    const finding = text(row.finding) ?? "No findings.";
    const detectedAt = text(row.detectedAt);
    return `${agent}: ${finding} (severity ${severity})${detectedAt ? ` at ${detectedAt}` : ""}`;
  }
  const title = text(row.title) ?? text(row.eventType) ?? "SAF event";
  const identity = text(row.identity);
  const when = text(row.receivedAt);
  return [when, title, identity ? `for ${identity}` : ""].filter(Boolean).join(" ");
}

function matchingSafEvents(events: SafEventInput[], query: string): SafEventInput[] {
  const newest = [...events].sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
  if (query === "*") {
    return newest;
  }
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return newest.filter((event) => {
    const haystack = [
      event.event.tenant,
      event.event.eventType,
      event.event.identity.name,
      event.event.agent.name ?? "",
      event.event.risk.title,
      event.event.risk.status,
      event.event.risk.severity,
    ]
      .join(" ")
      .toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "The read failed.";
  return message.slice(0, 240);
}

async function runRead(tool: AskToolName, query: string, deps: AskDeps): Promise<AskRead> {
  const base: AskRead = {
    tool,
    label: TOOL_LABELS[tool],
    query,
    tenant: deps.tenant,
    rows: [],
    truncated: false,
  };
  if (isWriteRequest(query)) {
    return { ...base, error: writeReason(deps.tenant) };
  }
  try {
    if (tool === "list_saf_events") {
      const matched = matchingSafEvents(await deps.safEvents(), query);
      return {
        ...base,
        rows: matched.slice(0, ROW_LIMIT).map(slimSaf),
        truncated: matched.length > ROW_LIMIT,
      };
    }
    if (tool === "list_agents") {
      if (!deps.tenant) {
        return { ...base, error: "Connect an ISC tenant before asking." };
      }
      const matched = matchingAgents(await deps.listAgents(), query);
      return {
        ...base,
        rows: matched.slice(0, ROW_LIMIT).map(slimAgent),
        truncated: matched.length > ROW_LIMIT,
      };
    }
    if (tool === "describe_agent") {
      if (!deps.tenant) {
        return { ...base, error: "Connect an ISC tenant before asking." };
      }
      const matched = matchingAgents(await deps.listAgents(), query);
      const candidates = matched.slice(0, AGENT_CANDIDATE_LIMIT);
      const rows: Record<string, unknown>[] = [];
      for (const candidate of candidates) {
        try {
          const snapshot = await deps.agentFindings(candidate.id);
          if (snapshot.findings.length === 0) {
            rows.push({
              agent: candidate.name,
              severity: snapshot.calculatedSeverity,
              finding: snapshot.findingsNote || "No findings.",
              detectedAt: "",
            });
          } else {
            for (const finding of snapshot.findings) {
              rows.push({
                agent: candidate.name,
                severity: snapshot.calculatedSeverity,
                finding: finding.title,
                detectedAt: finding.detectedAt,
              });
            }
          }
        } catch (candidateError) {
          rows.push({
            agent: candidate.name,
            severity: "Unavailable",
            finding: `Could not load findings: ${errorMessage(candidateError)}`,
            detectedAt: "",
          });
        }
      }
      return {
        ...base,
        rows: rows.slice(0, ROW_LIMIT),
        truncated: matched.length > candidates.length || rows.length > ROW_LIMIT,
      };
    }
    if (!deps.tenant) {
      return { ...base, error: "Connect an ISC tenant before asking." };
    }
    const raw = await deps.search(TOOL_INDICES[tool], query);
    const rows = raw.slice(0, ROW_LIMIT).map((row) => {
      if (tool === "search_identities") return slimIdentity(row);
      if (tool === "search_access") return slimAccess(row);
      return slimAudit(row);
    });
    return { ...base, rows, truncated: raw.length > ROW_LIMIT };
  } catch (error) {
    return { ...base, error: errorMessage(error) };
  }
}

export function formatAnswer(tenant: string | null, reads: AskRead[]): string {
  const lines = [tenantLine(tenant), `Each read returns at most ${ROW_LIMIT} rows.`];
  for (const read of reads) {
    const match = read.query === "*" ? "the newest rows" : read.query;
    if (read.error) {
      lines.push("", `${read.label}: ${read.error}`);
      continue;
    }
    const limitNote = read.truncated ? ", limit reached" : "";
    lines.push("", `${read.label} matching ${match} (${read.rows.length}${limitNote}):`);
    if (read.rows.length === 0) {
      lines.push("- None.");
      continue;
    }
    for (const row of read.rows) {
      lines.push(`- ${rowLine(read.tool, row)}`);
    }
  }
  return lines.join("\n");
}

export async function answerQuestion(question: string, deps: AskDeps): Promise<AskAnswer> {
  const trimmed = question.trim();
  if (!trimmed) {
    return {
      tenant: deps.tenant,
      refused: true,
      answer: "Ask a question about this tenant.",
      reads: [],
    };
  }
  if (isWriteRequest(trimmed)) {
    return {
      tenant: deps.tenant,
      refused: true,
      answer: writeReason(deps.tenant),
      reads: [],
    };
  }
  const query = searchText(trimmed).slice(0, 120);
  const reads: AskRead[] = [];
  for (const tool of toolsForQuestion(trimmed)) {
    reads.push(await runRead(tool, query, deps));
  }
  return {
    tenant: deps.tenant,
    refused: false,
    answer: formatAnswer(deps.tenant, reads),
    reads,
  };
}

export async function runAskTool(
  name: string,
  query: string | undefined,
  deps: AskDeps,
): Promise<AskRead> {
  if (!ASK_TOOL_NAMES.includes(name as AskToolName)) {
    return {
      tool: "search_identities",
      label: name,
      query: query ?? "*",
      tenant: deps.tenant,
      rows: [],
      truncated: false,
      error: `Unknown tool ${name}.`,
    };
  }
  const tool = name as AskToolName;
  const textQuery = (query?.trim() || "*").slice(0, 200);
  return runRead(tool, textQuery, deps);
}

export function readAsText(read: AskRead): string {
  if (read.error && read.rows.length === 0) {
    return `${tenantLine(read.tenant)}\n${read.label}: ${read.error}`;
  }
  return formatAnswer(read.tenant, [read]);
}

function rowsFromSearch(body: unknown): unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  const record = asRecord(body);
  if (!record) {
    return [];
  }
  for (const key of ["items", "results", "hits"]) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[];
    }
  }
  return [];
}

export async function searchConnectedTenant(
  credentials: IscCredentials,
  indices: string[],
  query: string,
): Promise<unknown[]> {
  if (isWriteRequest(query)) {
    throw new Error(writeReason(credentials.tenant));
  }
  const body = await iscRequest<unknown>(
    { ...credentials, sourceId: "ask-tenant" },
    "/search",
    {
      method: "POST",
      apiVersion: "v3",
      query: { limit: String(ROW_LIMIT), count: "false" },
      body: {
        indices,
        query: { query: query || "*" },
        includeNested: false,
      },
    },
  );
  return rowsFromSearch(body).slice(0, ROW_LIMIT);
}

export function liveAskDeps(): AskDeps {
  const credentials = getIscCredentials();
  return {
    tenant: credentials?.tenant ?? null,
    search: async (indices, query) => {
      if (!credentials) {
        throw new Error("Connect an ISC tenant before asking.");
      }
      return searchConnectedTenant(credentials, indices, query);
    },
    safEvents: async () => listSafEvents(),
    listAgents: async () => {
      if (!credentials) {
        throw new Error("Connect an ISC tenant before asking.");
      }
      return listTenantAgents();
    },
    agentFindings: async (agentId) => {
      if (!credentials) {
        throw new Error("Connect an ISC tenant before asking.");
      }
      return readAgentRiskSnapshot(agentId);
    },
  };
}
