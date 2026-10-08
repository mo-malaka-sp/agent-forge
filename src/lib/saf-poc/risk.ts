import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { buildAgentRiskEvent, ingestSafEvent } from "@/lib/saf-poc/events";
import { publishRiskLevelChange, type DeliveryReport } from "@/lib/saf-poc/transmitter";
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
  caep: { deliveries: DeliveryReport[] } | null;
  event: StoredEvent | null;
}> {
  const agentId = input.agentId.trim();
  const agentName = input.agentName?.trim() || agentId;
  if (!agentId) {
    throw new Error("Select an agent from the tenant.");
  }

  const currentLevel = normalizeLevel(input.riskLevel);
  const previousLevel = normalizeLevel(input.previousLevel || "low");
  const config = loadSafPocConfig();
  const identityEmail = (input.identityEmail || config.notifyEmail).trim().toLowerCase();
  if (!identityEmail) {
    throw new Error("Set SAF_NOTIFY_EMAIL or pass the correlated identity email.");
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

  return {
    agentId,
    agentName,
    previousLevel,
    currentLevel,
    identityEmail,
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

