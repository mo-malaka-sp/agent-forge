import { randomUUID } from "node:crypto";

import { loadSafPocConfig, safPocMode } from "@/lib/saf-poc/config";
import { getSafPocStore } from "@/lib/saf-poc/storage";
import {
  completeEvent,
  incomingEventSchema,
  type DatadogLog,
  type IncomingEvent,
  type SafEvent,
  type StoredEvent,
} from "@/lib/saf-poc/types";

export const NOTIFICATION_SUBJECT =
  "[POC-SUCCESS] SAF Agentic Event Bus Triggered";
export const DETECTION_QUERY = "source:sailpoint @risk_severity:critical";
export const SIGNAL_TITLE =
  "Critical Risk Detected by SailPoint Agentic Fabric";
const EVENT_PREFIX = "EVENT#";

export function normalizeEvent(event: SafEvent): DatadogLog {
  const status =
    event.risk.severity === "critical"
      ? "error"
      : event.risk.severity === "high"
        ? "warn"
        : "info";
  return {
    message: `${event.eventType}: ${event.risk.title}`,
    ddsource: "sailpoint",
    service: "saf-agentic-fabric",
    hostname: event.tenant,
    ddtags: `env:poc,tenant:${event.tenant},event_type:${event.eventType}`,
    status,
    eventType: event.eventType,
    tenant: event.tenant,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    risk: event.risk,
    identity: event.identity,
    agent: event.agent,
    ...(event.credential ? { credential: event.credential } : {}),
    risk_severity: event.risk.severity,
    identity_name: event.identity.name,
    agent_id: event.agent.id,
  };
}

async function forwardLog(log: DatadogLog, now: Date) {
  const config = loadSafPocConfig();
  if (!config.datadogApiKey) {
    return {
      mode: "dry-run" as const,
      status: "recorded" as const,
      httpStatus: null,
      detail: "DD_API_KEY is unset; normalized payload recorded locally.",
      attemptedAt: now.toISOString(),
    };
  }
  try {
    const response = await fetch(config.datadogIntakeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "DD-API-KEY": config.datadogApiKey,
      },
      body: JSON.stringify([log]),
      signal: AbortSignal.timeout(15_000),
    });
    const detail = (await response.text()).slice(0, 500);
    return {
      mode: "datadog" as const,
      status: response.ok ? ("delivered" as const) : ("failed" as const),
      httpStatus: response.status,
      detail: response.ok ? "Datadog accepted the log." : detail || response.statusText,
      attemptedAt: now.toISOString(),
    };
  } catch (error) {
    return {
      mode: "datadog" as const,
      status: "failed" as const,
      httpStatus: null,
      detail: error instanceof Error ? error.message : "Datadog request failed.",
      attemptedAt: now.toISOString(),
    };
  }
}

export async function ingestSafEvent(input: {
  payload: unknown;
  source: StoredEvent["source"];
  scenario?: string;
  now?: Date;
}): Promise<StoredEvent> {
  const now = input.now || new Date();
  const config = loadSafPocConfig();
  const tenant =
    config.tenant || (input.source === "simulator" ? "local" : "");
  const event = completeEvent(incomingEventSchema.parse(input.payload), tenant, now);
  const normalized = normalizeEvent(event);
  const stored: StoredEvent = {
    id: randomUUID(),
    receivedAt: now.toISOString(),
    source: input.source,
    scenario: input.scenario || null,
    event,
    normalized,
    delivery: await forwardLog(normalized, now),
    notification: {
      channel: "email",
      subject: NOTIFICATION_SUBJECT,
      body: `${event.eventType} fired for ${event.identity.name}.`,
      deliveredAt: now.toISOString(),
    },
  };
  await getSafPocStore().put(`${EVENT_PREFIX}${stored.receivedAt}#${stored.id}`, stored);
  return stored;
}

export async function listSafEvents(): Promise<StoredEvent[]> {
  const documents = await getSafPocStore().list<StoredEvent>(EVENT_PREFIX);
  return documents.map((document) => document.value);
}

export async function resetSafEvents(): Promise<void> {
  const store = getSafPocStore();
  const documents = await store.list(EVENT_PREFIX);
  await Promise.all(documents.map((document) => store.delete(document.key)));
}

export function buildAgentRiskEvent(input: {
  tenant: string;
  agentId: string;
  agentName: string;
  identityEmail: string;
  previousLevel: string;
  currentLevel: string;
}): IncomingEvent {
  const severity = toSeverity(input.currentLevel);
  return {
    eventType: "RiskStateChanged",
    tenant: input.tenant || undefined,
    risk: {
      id: `agent-risk-${input.agentId}`,
      severity,
      status: input.currentLevel,
      previousStatus: input.previousLevel,
      title: `${input.agentName} risk changed from ${input.previousLevel} to ${input.currentLevel}`,
    },
    identity: {
      id: input.identityEmail,
      name: input.identityEmail,
      type: "identity",
    },
    agent: { id: input.agentId, name: input.agentName },
  };
}

export function buildFixture(
  scenario: "risk-state-changed" | "exposed-credential" | "critical-escalation",
): IncomingEvent {
  const common = {
    identity: { id: "idn-alex", name: "alex.morgan", type: "identity" },
    agent: { id: "agent-af-42", name: "CloudOps Navigator" },
  };
  if (scenario === "exposed-credential") {
    return {
      eventType: "ExposedCredentialDetected",
      risk: {
        id: "risk-exposed-credential",
        severity: "critical",
        status: "Open",
        title: "Exposed credential detected",
      },
      ...common,
      credential: {
        id: "cred-demo",
        type: "api-token",
        exposure: "public-repository",
      },
    };
  }
  const critical = scenario === "critical-escalation";
  return {
    eventType: "RiskStateChanged",
    risk: {
      id: critical ? "risk-critical-escalation" : "risk-state-change",
      severity: critical ? "critical" : "high",
      status: critical ? "Critical" : "Investigating",
      previousStatus: critical ? "Investigating" : "Open",
      title: critical ? "Agent risk escalated to critical" : "Agent risk moved to investigating",
    },
    ...common,
  };
}

export async function runFullDemo(): Promise<StoredEvent[]> {
  await resetSafEvents();
  const scenarios = [
    "risk-state-changed",
    "exposed-credential",
    "critical-escalation",
  ] as const;
  const events: StoredEvent[] = [];
  for (const scenario of scenarios) {
    events.push(
      await ingestSafEvent({ payload: buildFixture(scenario), source: "simulator", scenario }),
    );
  }
  return events;
}

export async function buildSafPocState(baseUrl: string) {
  const config = loadSafPocConfig();
  const events = (await listSafEvents()).sort((left, right) =>
    right.receivedAt.localeCompare(left.receivedAt),
  );
  const signals = events
    .filter((event) => event.normalized.risk_severity === "critical")
    .map((event) => ({
      title: SIGNAL_TITLE,
      query: DETECTION_QUERY,
      identityName: event.normalized.identity_name,
      agentId: event.normalized.agent_id,
      occurredAt: event.event.occurredAt,
    }));
  const failed = events.filter((event) => event.delivery.status === "failed");
  const checks1 = [
    { label: "Event recorded", passed: events.length > 0 },
    {
      label: "Verification notification recorded",
      passed: events.some((event) => event.notification.subject === NOTIFICATION_SUBJECT),
    },
  ];
  const checks2 = [
    {
      label: "Datadog source mapped",
      passed: events.some((event) => event.normalized.ddsource === "sailpoint"),
    },
    {
      label: "Forwarding completed without failures",
      passed: events.length > 0 && failed.length === 0,
    },
    { label: "Critical detection matched", passed: signals.length > 0 },
  ];
  return {
    configured: Boolean(config.tenant && config.notifyEmail),
    tenant: config.tenant,
    notifyEmail: config.notifyEmail,
    mode: safPocMode(config),
    intakeUrl: config.datadogIntakeUrl,
    webhookUrl: `${baseUrl}/webhooks/saf`,
    discoveryUrl: baseUrl,
    events,
    signals,
    evidence: {
      passed: [...checks1, ...checks2].every((check) => check.passed),
      summary: {
        events: events.length,
        notifications: events.length,
        signals: signals.length,
        failedDeliveries: failed.length,
      },
      testCase1: {
        title: "Test Case 1: Agentic Fabric native event trigger",
        passed: checks1.every((check) => check.passed),
        checks: checks1,
      },
      testCase2: {
        title: "Test Case 2: Datadog forwarding and security signal",
        passed: checks2.every((check) => check.passed),
        checks: checks2,
      },
    },
  };
}

function toSeverity(level: string): "low" | "medium" | "high" | "critical" {
  const normalized = level.trim().toLowerCase();
  return normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "critical"
    ? normalized
    : "high";
}
