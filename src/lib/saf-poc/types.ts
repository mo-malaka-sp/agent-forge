import { randomUUID } from "node:crypto";

import { z } from "zod";

export const severitySchema = z.enum(["low", "medium", "high", "critical"]);
export const eventTypeSchema = z.enum([
  "RiskStateChanged",
  "ExposedCredentialDetected",
]);

export const incomingEventSchema = z
  .object({
    eventId: z.string().min(1).optional(),
    eventType: eventTypeSchema,
    occurredAt: z.iso.datetime().optional(),
    tenant: z.string().min(1).optional(),
    risk: z.object({
      id: z.string().min(1),
      severity: severitySchema,
      status: z.string().min(1),
      previousStatus: z.string().min(1).optional(),
      title: z.string().min(1),
    }),
    identity: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      type: z.string().min(1).optional(),
    }),
    agent: z.object({
      id: z.string().min(1),
      name: z.string().min(1).optional(),
    }),
    credential: z
      .object({
        id: z.string().min(1),
        type: z.string().min(1),
        exposure: z.string().min(1),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.eventType === "ExposedCredentialDetected" && !value.credential) {
      context.addIssue({
        code: "custom",
        path: ["credential"],
        message: "Exposed credential events must include a credential.",
      });
    }
  });

export type IncomingEvent = z.infer<typeof incomingEventSchema>;
export type Severity = z.infer<typeof severitySchema>;

export interface SafEvent extends Omit<IncomingEvent, "eventId" | "occurredAt" | "tenant"> {
  eventId: string;
  occurredAt: string;
  tenant: string;
}

export interface DatadogLog {
  message: string;
  ddsource: "sailpoint";
  service: "saf-agentic-fabric";
  hostname: string;
  ddtags: string;
  status: "info" | "warn" | "error";
  eventType: IncomingEvent["eventType"];
  tenant: string;
  eventId: string;
  occurredAt: string;
  risk: SafEvent["risk"];
  identity: SafEvent["identity"];
  agent: SafEvent["agent"];
  credential?: SafEvent["credential"];
  risk_severity: Severity;
  identity_name: string;
  agent_id: string;
}

export interface DeliveryResult {
  mode: "dry-run" | "datadog";
  status: "recorded" | "delivered" | "failed";
  httpStatus: number | null;
  detail: string;
  attemptedAt: string;
}

export interface StoredEvent {
  id: string;
  receivedAt: string;
  source: "webhook" | "simulator" | "agent-risk";
  scenario: string | null;
  event: SafEvent;
  normalized: DatadogLog;
  delivery: DeliveryResult;
  notification: {
    channel: "email";
    subject: string;
    body: string;
    deliveredAt: string;
  };
}

export function completeEvent(
  input: IncomingEvent,
  tenant: string,
  now = new Date(),
): SafEvent {
  const resolvedTenant = input.tenant || tenant;
  if (!resolvedTenant) {
    throw new Error("Configure an ISC tenant before ingesting SAF events.");
  }
  return {
    ...input,
    eventId: input.eventId || randomUUID(),
    occurredAt: input.occurredAt || now.toISOString(),
    tenant: resolvedTenant,
  };
}
