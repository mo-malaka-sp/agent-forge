import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { buildAgentRiskEvent, ingestSafEvent } from "@/lib/saf-poc/events";
import { publishRiskLevelChange, type DeliveryReport } from "@/lib/saf-poc/transmitter";
import {
  emailAddress,
  listTenantAgents,
  readAgentRiskSnapshot,
  resolveAgentOwnerEmail,
  type AgentFinding,
} from "@/lib/saf-poc/tenant-agents";
import type { StoredEvent } from "@/lib/saf-poc/types";

const LEVELS = new Set(["low", "medium", "high", "critical"]);

export async function changeAgentRisk(input: {
  agentId: string;
  agentName?: string;
  riskLevel: string;
  previousLevel?: string;
  identityEmail?: string;
  publicUrl: string;
  transmit?: boolean;
  ingest?: boolean;
}): Promise<{
  agentId: string;
  agentName: string;
  previousLevel: string;
  currentLevel: string;
  identityEmail: string;
  riskUpdate: string;
  calculatedSeverity: string;
  findings: AgentFinding[];
  findingsNote: string;
  caep: { deliveries: DeliveryReport[] } | null;
  event: StoredEvent | null;
}> {
  const agentId = input.agentId.trim();
  if (!agentId) {
    throw new Error("Select an agent from the tenant.");
  }

  const currentLevel = normalizeLevel(input.riskLevel);
  const previousLevel = normalizeLevel(input.previousLevel || "low");
  const config = loadSafPocConfig();
  const agents = await listTenantAgents(config);
  const agent = agents.find((candidate) => candidate.id === agentId);
  const agentName = agent?.name || input.agentName?.trim() || agentId;
  const ownerEmail = agent ? await resolveAgentOwnerEmail(agent, config) : "";
  const identityEmail =
    emailAddress(input.identityEmail ?? "") ||
    emailAddress(ownerEmail) ||
    emailAddress(config.notifyEmail);
  if (!identityEmail) {
    const owner = agent?.ownerName ? `Owner ${agent.ownerName}` : "The agent owner";
    throw new Error(`${owner} has no email address SailPoint can correlate.`);
  }
  const caep =
    input.transmit === false
      ? null
      : await publishRiskLevelChange({
          publicUrl: input.publicUrl,
          email: identityEmail,
          previousLevel: previousLevel.toUpperCase(),
          currentLevel: currentLevel.toUpperCase(),
        });

  const event =
    input.ingest === false
      ? null
      : await ingestSafEvent({
          source: "agent-risk",
          scenario: "agent-risk-change",
          payload: buildAgentRiskEvent({
            tenant: config.tenant,
            agentId,
            agentName,
            identityEmail,
            previousLevel,
            currentLevel,
          }),
        });

  const snapshot = await readAgentRiskSnapshot(agentId, config);
  const riskUpdate = `CAEP level sent: ${currentLevel}. Calculated Risk Severity: ${snapshot.calculatedSeverity}.`;

  return {
    agentId,
    agentName,
    previousLevel,
    currentLevel,
    identityEmail,
    riskUpdate,
    calculatedSeverity: snapshot.calculatedSeverity,
    findings: snapshot.findings,
    findingsNote: snapshot.findingsNote,
    caep,
    event,
  };
}

function normalizeLevel(value: string): string {
  const level = value.trim().toLowerCase();
  if (!LEVELS.has(level)) {
    throw new Error("Risk level must be low, medium, high, or critical.");
  }
  return level;
}

