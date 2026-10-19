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

export const AGENT_CONDITION_UNAVAILABLE =
  "AgentForge cannot change this agent's Risk Engine signals yet. No event was sent.";

export async function changeAgentRisk(input: {
  agentId: string;
  agentName?: string;
  riskLevel: string;
  previousLevel?: string;
  identityEmail?: string;
  publicUrl: string;
  transmit?: boolean;
  ingest?: boolean;
  mode?: "test-event" | "agent-condition";
  fetchImpl?: typeof fetch;
}): Promise<{
  agentId: string;
  agentName: string;
  previousLevel: string;
  currentLevel: string;
  requestedLevel: string;
  identityEmail: string;
  riskUpdate: string;
  calculatedSeverity: string;
  findings: AgentFinding[];
  findingsNote: string;
  caep: { deliveries: DeliveryReport[] } | null;
  event: StoredEvent | null;
}> {
  if (input.mode === "agent-condition") {
    throw new Error(AGENT_CONDITION_UNAVAILABLE);
  }
  const agentId = input.agentId.trim();
  if (!agentId) {
    throw new Error("Select an agent from the tenant.");
  }

  const currentLevel = normalizeLevel(input.riskLevel);
  const previousLevel = normalizeLevel(input.previousLevel || "low");
  const config = loadSafPocConfig();
  const agents = await listTenantAgents(config, input.fetchImpl);
  const agent = agents.find((candidate) => candidate.id === agentId);
  const agentName = agent?.name || input.agentName?.trim() || agentId;
  const ownerEmail = agent ? await resolveAgentOwnerEmail(agent, config, input.fetchImpl) : "";
  const identityEmail = emailAddress(ownerEmail);
  if (!identityEmail) {
    throw new Error(
      "This agent has no owner email, so SailPoint cannot correlate the event.",
    );
  }
  const caep =
    input.transmit === false
      ? null
      : await publishRiskLevelChange({
          publicUrl: input.publicUrl,
          email: identityEmail,
          agentName,
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

  const snapshot = await readAgentRiskSnapshot(agentId, config, input.fetchImpl);
  const riskUpdate = `CAEP sent ${currentLevel}. Agent Risk Severity is still ${snapshot.calculatedSeverity}.`;

  return {
    agentId,
    agentName,
    previousLevel,
    currentLevel,
    requestedLevel: currentLevel,
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

