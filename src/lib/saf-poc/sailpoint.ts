import type { SafPocConfig } from "@/lib/saf-poc/config";
import { NOTIFICATION_SUBJECT } from "@/lib/saf-poc/events";

export const POC_WORKFLOW_NAME = "POC SAF Event Bus Email";
export const POC_DATADOG_WORKFLOW_NAME = "POC SAF Datadog Intake";
export const WORKFLOWS_PATH = "/workflows/v1";
export const WORKFLOW_TRIGGERS_PATH = "/workflow-library/v1/triggers";
export const TRIGGER_SUBSCRIPTIONS_PATH = "/trigger-subscriptions/v1";
const RISK_LEVEL_CHANGE_TRIGGER_ID = "idn:caep-risk-level-change-events";
const RISK_LEVEL_CHANGE_EVENT =
  "https://schemas.openid.net/secevent/caep/event-type/risk-level-change";
const RISK_LEVEL_CHANGE_FILTER = `$.ssfEvent.events["${RISK_LEVEL_CHANGE_EVENT}"]`;

export class SailPointApiError extends Error {
  readonly status: number;

  constructor(status: number, responseBody: string) {
    super(`SailPoint API returned HTTP ${status}. ${responseBody}`.slice(0, 500));
    this.name = "SailPointApiError";
    this.status = status;
  }
}

export type WorkflowTrigger = {
  id: string;
  name: string;
  type: "EVENT" | "SCHEDULED" | "EXTERNAL";
};

export type DatadogWorkflowSetup = {
  tenant: string;
  origin: string;
  trigger: WorkflowTrigger;
  workflowId: string;
  workflowName: string;
  enabled: boolean;
  webhookUrl: string;
  created: boolean;
  testExecutionId: string | null;
};

export type WorkflowSetup = {
  tenant: string;
  origin: string;
  trigger: WorkflowTrigger;
  workflowId: string;
  workflowName: string;
  enabled: boolean;
  email: string;
  created: boolean;
  testExecutionId: string | null;
  subscription: {
    id: string;
    enabled: boolean;
    triggerId: string;
    filter: string;
  } | null;
};

type LibraryTrigger = {
  id?: string;
  name?: string;
  displayName?: string;
  type?: string;
  attributes?: { id?: string; name?: string };
};

type WorkflowRecord = {
  id?: string;
  name?: string;
  enabled?: boolean;
};

type TriggerSubscriptionRecord = {
  id?: string;
  enabled?: boolean;
  triggerId?: string;
  filter?: string;
  workflowConfig?: { workflowId?: string };
};

type FetchLike = typeof fetch;

export type SailPointSetupConfig = Pick<
  SafPocConfig,
  | "tenant"
  | "apiBase"
  | "clientId"
  | "clientSecret"
  | "ownerId"
  | "ownerName"
  | "triggerName"
  | "notifyEmail"
>;

export function identityFromAccessToken(token: string): {
  id: string;
  name: string;
} {
  const payload = token.split(".")[1];
  if (!payload) {
    return { id: "", name: "" };
  }
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    return {
      id: typeof claims.identity_id === "string" ? claims.identity_id : "",
      name:
        typeof claims.user_name === "string"
          ? claims.user_name
          : typeof claims.name === "string"
            ? claims.name
            : "",
    };
  } catch {
    return { id: "", name: "" };
  }
}

function triggerFromLibrary(trigger: LibraryTrigger): WorkflowTrigger | null {
  const id = trigger.attributes?.id || trigger.id || "";
  const name = trigger.name || trigger.displayName || trigger.attributes?.name || id;
  const type =
    trigger.type === "SCHEDULED" || trigger.type === "EXTERNAL"
      ? trigger.type
      : "EVENT";
  if (!id || !name) {
    return null;
  }
  return { id, name, type };
}

function matchesTrigger(trigger: WorkflowTrigger, expected: string): boolean {
  const needle = expected.trim().toLowerCase();
  return (
    trigger.name.toLowerCase() === needle || trigger.id.toLowerCase() === needle
  );
}

export function buildWorkflowBody(input: {
  ownerId: string;
  ownerName: string;
  email: string;
  trigger: WorkflowTrigger;
}): Record<string, unknown> {
  const owner: Record<string, string> = { type: "IDENTITY", id: input.ownerId };
  if (input.ownerName) {
    owner.name = input.ownerName;
  }
  return {
    name: POC_WORKFLOW_NAME,
    owner,
    description:
      "Sends the POC verification email when the configured trigger fires.",
    enabled: false,
    definition: {
      start: "Send Email",
      steps: {
        "Send Email": {
          actionId: "sp:send-email",
          versionNumber: 2,
          attributes: {
            recipientEmailList: [input.email],
            subject: NOTIFICATION_SUBJECT,
            body: "<p>The Agentic Fabric event bus fired the verification workflow.</p>",
            context: {},
          },
          nextStep: "success",
          type: "action",
        },
        success: { type: "success" },
      },
    },
    trigger: {
      type: input.trigger.type,
      attributes: {
        id: input.trigger.id,
        ...(input.trigger.id === RISK_LEVEL_CHANGE_TRIGGER_ID ||
        input.trigger.name === "CAEP Risk Level Change Events"
          ? { "filter.$": RISK_LEVEL_CHANGE_FILTER }
          : {}),
      },
    },
  };
}

export function buildWorkflowTestInput(
  trigger: WorkflowTrigger,
  email: string,
): Record<string, unknown> {
  if (
    trigger.id !== RISK_LEVEL_CHANGE_TRIGGER_ID &&
    trigger.name !== "CAEP Risk Level Change Events"
  ) {
    return {};
  }
  return {
    pk: `poc#${email}`,
    correlatedID: { format: "email", value: email },
    identityAttributes: {
      id: "poc-test-identity",
      name: "POC Test",
      alias: email,
      type: null,
      state: "ACTIVE",
      inactive: false,
      protected: false,
      disabled: false,
      correlated: true,
      created: "2026-10-07T00:00:00.000Z",
      modified: "2026-10-07T00:00:00.000Z",
    },
    ssfEvent: {
      iss: "https://agentforge.example/",
      jti: "poc-risk-level-change",
      iat: 1748625243,
      aud: ["https://sp.example.com/caep"],
      txn: 8675309,
      sub_id: { format: "complex", user: { format: "email", email }, email },
      events: {
        [RISK_LEVEL_CHANGE_EVENT]: {
          current_level: "HIGH",
          previous_level: "LOW",
          event_timestamp: 1615304991,
          principal: "USER",
          risk_reason: "PASSWORD_FOUND_IN_DATA_BREACH",
        },
      },
    },
  };
}

async function readError(response: Response): Promise<string> {
  return (await response.text()).slice(0, 500);
}

export function createSailPointClient(
  config: SailPointSetupConfig,
  fetchImpl: FetchLike = fetch,
) {
  const origin = config.apiBase;
  let accessToken = "";

  const authorize = async (): Promise<string> => {
    if (!config.clientId || !config.clientSecret) {
      throw new Error(
        "Save the ISC tenant connection, or set SAF_CLIENT_ID and SAF_CLIENT_SECRET.",
      );
    }
    if (!origin) {
      throw new Error("Set SAF_TENANT or save the ISC tenant connection first.");
    }
    const response = await fetchImpl(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }).toString(),
    });
    if (!response.ok) {
      throw new SailPointApiError(response.status, await readError(response));
    }
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new Error("SailPoint token response did not include an access token.");
    }
    accessToken = body.access_token;
    return accessToken;
  };

  const request = async (
    method: string,
    requestPath: string,
    body?: unknown,
    contentType = "application/json",
    extraHeaders?: Record<string, string>,
  ) => {
    if (!accessToken) {
      await authorize();
    }
    const response = await fetchImpl(`${origin}${requestPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...extraHeaders,
        ...(body === undefined ? {} : { "Content-Type": contentType }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new SailPointApiError(response.status, await readError(response));
    }
    if (response.status === 204) {
      return null;
    }
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : null;
  };

  const listAll = async <T>(
    requestPath: string,
    extraHeaders?: Record<string, string>,
  ): Promise<T[]> => {
    const records: T[] = [];
    const limit = 250;
    for (let offset = 0; ; offset += limit) {
      const separator = requestPath.includes("?") ? "&" : "?";
      const page = (await request(
        "GET",
        `${requestPath}${separator}limit=${limit}&offset=${offset}`,
        undefined,
        "application/json",
        extraHeaders,
      )) as T[] | { items?: T[] } | null;
      const items = Array.isArray(page)
        ? page
        : page && Array.isArray(page.items)
          ? page.items
          : null;
      if (!items) {
        throw new Error("SailPoint list response was not an array.");
      }
      records.push(...items);
      if (items.length < limit || records.length >= 1000) {
        return records;
      }
    }
  };

  return {
    origin,
    authorize,
    async listTriggers(): Promise<WorkflowTrigger[]> {
      const library = await listAll<LibraryTrigger>(WORKFLOW_TRIGGERS_PATH);
      return library.flatMap((trigger) => {
        const parsed = triggerFromLibrary(trigger);
        return parsed ? [parsed] : [];
      });
    },
    async findWorkflow(name = POC_WORKFLOW_NAME): Promise<WorkflowRecord | null> {
      const workflows = await listAll<WorkflowRecord>(WORKFLOWS_PATH);
      return workflows.find((workflow) => workflow.name === name) ?? null;
    },
    async findWorkflowSubscription(
      workflowId: string,
    ): Promise<TriggerSubscriptionRecord | null> {
      try {
        const subscriptions = await listAll<TriggerSubscriptionRecord>(
          TRIGGER_SUBSCRIPTIONS_PATH,
        );
        return (
          subscriptions.find(
            (subscription) => subscription.workflowConfig?.workflowId === workflowId,
          ) ?? null
        );
      } catch (error) {
        if (
          error instanceof SailPointApiError &&
          (error.status === 403 || error.status === 404)
        ) {
          return null;
        }
        throw error;
      }
    },
    async listRecords(
      requestPath: string,
      extraHeaders?: Record<string, string>,
    ): Promise<unknown[]> {
      return listAll<unknown>(requestPath, extraHeaders);
    },
    request,
  };
}

export async function setupTest1(
  config: SailPointSetupConfig,
  options: { fetchImpl?: FetchLike; sendTest?: boolean } = {},
): Promise<WorkflowSetup> {
  if (!config.tenant) {
    throw new Error("Set SAF_TENANT or save the ISC tenant connection first.");
  }
  if (!config.notifyEmail) {
    throw new Error(
      "Set SAF_NOTIFY_EMAIL to the inbox that should receive the verification email.",
    );
  }

  const client = createSailPointClient(config, options.fetchImpl);
  const token = await client.authorize();
  const tokenIdentity = identityFromAccessToken(token);
  const ownerId = config.ownerId || tokenIdentity.id;
  const ownerName = config.ownerName || tokenIdentity.name;
  if (!ownerId) {
    throw new Error(
      "Set SAF_OWNER_ID to the admin identity that will own the workflow.",
    );
  }

  const triggers = await client.listTriggers();
  const trigger = triggers.find((candidate) =>
    matchesTrigger(candidate, config.triggerName),
  );
  if (!trigger) {
    const available = triggers.map((candidate) => candidate.name).sort();
    throw new Error(
      `No workflow trigger matches "${config.triggerName}". Available triggers: ${available.join(", ") || "none"}.`,
    );
  }

  const body = buildWorkflowBody({
    ownerId,
    ownerName,
    email: config.notifyEmail,
    trigger,
  });
  const existing = await client.findWorkflow();
  let workflowId = existing?.id ?? "";
  const created = !workflowId;

  if (existing?.id && existing.enabled) {
    await client.request(
      "PATCH",
      `${WORKFLOWS_PATH}/${existing.id}`,
      [{ op: "replace", path: "/enabled", value: false }],
      "application/json-patch+json",
    );
  }
  if (workflowId) {
    await client.request("PUT", `${WORKFLOWS_PATH}/${workflowId}`, body);
  } else {
    const createdWorkflow = (await client.request(
      "POST",
      WORKFLOWS_PATH,
      body,
    )) as WorkflowRecord;
    workflowId = createdWorkflow.id ?? "";
  }
  if (!workflowId) {
    throw new Error("SailPoint did not return a workflow id.");
  }

  let testExecutionId: string | null = null;
  if (options.sendTest) {
    const execution = (await client.request(
      "POST",
      `${WORKFLOWS_PATH}/${workflowId}/test`,
      { input: buildWorkflowTestInput(trigger, config.notifyEmail) },
    )) as { workflowExecutionId?: string } | null;
    testExecutionId = execution?.workflowExecutionId ?? null;
  }

  await client.request(
    "PATCH",
    `${WORKFLOWS_PATH}/${workflowId}`,
    [{ op: "replace", path: "/enabled", value: true }],
    "application/json-patch+json",
  );
  const subscriptionRecord = await client.findWorkflowSubscription(workflowId);

  return {
    tenant: config.tenant,
    origin: client.origin,
    trigger,
    workflowId,
    workflowName: POC_WORKFLOW_NAME,
    enabled: true,
    email: config.notifyEmail,
    created,
    testExecutionId,
    subscription: subscriptionRecord?.id
      ? {
          id: subscriptionRecord.id,
          enabled: Boolean(subscriptionRecord.enabled),
          triggerId: subscriptionRecord.triggerId ?? "",
          filter: subscriptionRecord.filter ?? "",
        }
      : null,
  };
}

export function buildDatadogWebhookPayload(): Record<string, unknown> {
  return {
    eventType: "RiskStateChanged",
    risk: {
      id: "databricks-policy-risk",
      severity: "critical",
      status: "open",
      previousStatus: "low",
      title: "Policy Concierge risk changed",
    },
    identity: {
      id: "sp-agent-policy",
      name: "sp-agent-policy",
      type: "service-principal",
    },
    agent: {
      id: "ka-9ba32b9f-endpoint",
      name: "Policy-Concierge",
    },
  };
}

export function selectExternalTrigger(
  triggers: WorkflowTrigger[],
): WorkflowTrigger | null {
  return (
    triggers.find((trigger) => trigger.type === "EXTERNAL") ??
    triggers.find((trigger) => trigger.name.toLowerCase().includes("external")) ??
    null
  );
}

export function buildDatadogWorkflowBody(input: {
  ownerId: string;
  ownerName: string;
  trigger: WorkflowTrigger;
  webhookUrl: string;
  webhookToken: string;
}): Record<string, unknown> {
  const owner: Record<string, string> = { type: "IDENTITY", id: input.ownerId };
  if (input.ownerName) {
    owner.name = input.ownerName;
  }
  const requestHeaders: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (input.webhookToken) {
    requestHeaders["x-saf-webhook-token"] = input.webhookToken;
  }
  return {
    name: POC_DATADOG_WORKFLOW_NAME,
    owner,
    description: "Posts a SAF risk event to the AgentForge Datadog webhook.",
    enabled: false,
    definition: {
      start: "Post Datadog Webhook",
      steps: {
        "Post Datadog Webhook": {
          actionId: "sp:http",
          versionNumber: 2,
          attributes: {
            method: "post",
            url: input.webhookUrl,
            requestContentType: "json",
            requestHeaders,
            jsonRequestBody: buildDatadogWebhookPayload(),
          },
          nextStep: "success",
          type: "action",
        },
        success: { type: "success" },
      },
    },
    trigger: {
      type: input.trigger.type,
      attributes: {
        id: input.trigger.id,
      },
    },
  };
}

export async function setupTest2(
  config: SailPointSetupConfig,
  options: {
    webhookUrl: string;
    webhookToken: string;
    fetchImpl?: FetchLike;
    sendTest?: boolean;
  },
): Promise<DatadogWorkflowSetup> {
  if (!config.tenant) {
    throw new Error("Set SAF_TENANT or save the ISC tenant connection first.");
  }
  const webhookUrl = options.webhookUrl.trim();
  if (!webhookUrl.startsWith("https://")) {
    throw new Error(
      "SailPoint can call the Datadog webhook only at the public HTTPS AgentForge URL.",
    );
  }

  const client = createSailPointClient(config, options.fetchImpl);
  const token = await client.authorize();
  const tokenIdentity = identityFromAccessToken(token);
  const ownerId = config.ownerId || tokenIdentity.id;
  const ownerName = config.ownerName || tokenIdentity.name;
  if (!ownerId) {
    throw new Error(
      "Set SAF_OWNER_ID to the admin identity that will own the workflow.",
    );
  }

  const trigger = selectExternalTrigger(await client.listTriggers());
  if (!trigger) {
    throw new Error(
      "No external workflow trigger is available, so the Datadog workflow cannot be tested.",
    );
  }

  const body = buildDatadogWorkflowBody({
    ownerId,
    ownerName,
    trigger,
    webhookUrl,
    webhookToken: options.webhookToken,
  });
  const existing = await client.findWorkflow(POC_DATADOG_WORKFLOW_NAME);
  let workflowId = existing?.id ?? "";
  const created = !workflowId;

  if (existing?.id && existing.enabled) {
    await client.request(
      "PATCH",
      `${WORKFLOWS_PATH}/${existing.id}`,
      [{ op: "replace", path: "/enabled", value: false }],
      "application/json-patch+json",
    );
  }
  if (workflowId) {
    await client.request("PUT", `${WORKFLOWS_PATH}/${workflowId}`, body);
  } else {
    const createdWorkflow = (await client.request(
      "POST",
      WORKFLOWS_PATH,
      body,
    )) as WorkflowRecord;
    workflowId = createdWorkflow.id ?? "";
  }
  if (!workflowId) {
    throw new Error("SailPoint did not return a workflow id.");
  }

  let testExecutionId: string | null = null;
  if (options.sendTest) {
    const execution = (await client.request(
      "POST",
      `${WORKFLOWS_PATH}/${workflowId}/test`,
      { input: {} },
    )) as { workflowExecutionId?: string } | null;
    testExecutionId = execution?.workflowExecutionId ?? null;
  }

  await client.request(
    "PATCH",
    `${WORKFLOWS_PATH}/${workflowId}`,
    [{ op: "replace", path: "/enabled", value: true }],
    "application/json-patch+json",
  );

  return {
    tenant: config.tenant,
    origin: client.origin,
    trigger,
    workflowId,
    workflowName: POC_DATADOG_WORKFLOW_NAME,
    enabled: true,
    webhookUrl,
    created,
    testExecutionId,
  };
}
