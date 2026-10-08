import { findAgentById, updateAgent } from "@/lib/db/store";
import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { buildAgentRiskEvent, ingestSafEvent } from "@/lib/saf-poc/events";
import { publishRiskLevelChange, type DeliveryReport } from "@/lib/saf-poc/transmitter";
import type { StoredEvent } from "@/lib/saf-poc/types";

const LEVELS = new Set(["low", "medium", "high", "critical"]);

export async function changeAgentRisk(input: {
  agentId: string;
  riskLevel: string;
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
  const agent = findAgentById(input.agentId.trim());
  if (!agent) {
    throw new Error(`Agent ${input.agentId} was not found.`);
  }

  const currentLevel = normalizeLevel(input.riskLevel);
  const metadata = parseMetadata(agent.metadata);
  const previousLevel = normalizeLevel(metadata.risk_level || "low");
  metadata.risk_level = titleCase(currentLevel);
  const timestamp = new Date().toISOString();
  const updated = updateAgent(agent.id, {
    metadata: JSON.stringify(metadata),
    updatedAt: timestamp,
    lastActiveAt: timestamp,
  });
  if (!updated) {
    throw new Error(`Agent ${agent.id} could not be updated.`);
  }

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
            agentId: agent.id,
            agentName: agent.name,
            identityEmail,
            previousLevel,
            currentLevel,
          }),
        });

  return {
    agentId: agent.id,
    agentName: agent.name,
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

function titleCase(level: string): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function parseMetadata(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}
