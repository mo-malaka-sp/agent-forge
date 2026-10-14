import type { SafPocConfig } from "@/lib/saf-poc/config";

export const SIGNAL_TITLE = "Critical Risk Detected by SailPoint Agentic Fabric";
export const DETECTION_QUERY =
  "source:sailpoint @evt.category:security @evt.outcome:critical";
const HIGH_QUERY = "source:sailpoint @evt.category:security @evt.outcome:high";

let ruleReady = false;
let pending: Promise<string> | null = null;

export function resetDatadogSecurityForTests(): void {
  ruleReady = false;
  pending = null;
}

export function datadogApiBase(intakeUrl: string): string {
  try {
    const site = new URL(intakeUrl).hostname.replace(/^http-intake\.logs\./, "");
    if (site && site !== new URL(intakeUrl).hostname) {
      return `https://api.${site}`;
    }
  } catch {
    // Fall through to the US1 API.
  }
  return "https://api.datadoghq.com";
}

export async function ensureSecuritySignalRule(
  config: SafPocConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config.datadogApiKey || !config.datadogAppKey) {
    return "Set DD_APP_KEY to open a Security Inbox signal.";
  }
  if (ruleReady) {
    return "Security Inbox rule is ready.";
  }
  if (!pending) {
    pending = createOrUpdateRule(config, fetchImpl)
      .then((message) => {
        ruleReady = true;
        return message;
      })
      .finally(() => {
        pending = null;
      });
  }
  try {
    return await pending;
  } catch (error) {
    return error instanceof Error ? error.message : "Security signal rule failed.";
  }
}

function ruleBody(version?: number): Record<string, unknown> {
  return {
    ...(typeof version === "number" ? { version } : {}),
    name: SIGNAL_TITLE,
    type: "log_detection",
    isEnabled: true,
    message:
      "SailPoint reported {{@evt.name}} for {{@usr.name}} ({{@usr.id}}) on agent {{@agent.name}}. Severity {{@evt.outcome}}.\n\n[Open affected agent in SailPoint]({{@sailpoint.url}})",
    tags: ["source:sailpoint", "env:poc"],
    queries: [
      {
        name: "a",
        query: DETECTION_QUERY,
        aggregation: "count",
        dataSource: "logs",
        groupByFields: [],
        distinctFields: [],
      },
      {
        name: "b",
        query: HIGH_QUERY,
        aggregation: "count",
        dataSource: "logs",
        groupByFields: [],
        distinctFields: [],
      },
    ],
    cases: [
      {
        name: "Critical risk",
        status: "critical",
        condition: "a > 0",
        notifications: [],
      },
      {
        name: "High risk",
        status: "high",
        condition: "b > 0",
        notifications: [],
      },
    ],
    options: {
      detectionMethod: "threshold",
      evaluationWindow: 0,
      keepAlive: 0,
      maxSignalDuration: 0,
    },
  };
}

async function createOrUpdateRule(
  config: SafPocConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  const api = datadogApiBase(config.datadogIntakeUrl);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "DD-API-KEY": config.datadogApiKey,
    "DD-APPLICATION-KEY": config.datadogAppKey,
  };
  const existing = await findRule(api, headers, fetchImpl);
  const url = existing?.id
    ? `${api}/api/v2/security_monitoring/rules/${existing.id}`
    : `${api}/api/v2/security_monitoring/rules`;
  const body = ruleBody(existing?.version);
  if (existing?.id) {
    delete body.type;
  }
  const saved = await fetchImpl(url, {
    method: existing?.id ? "PUT" : "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!saved.ok) {
    const detail = (await saved.text()).slice(0, 300);
    if (detail.includes("AlreadyExists")) {
      return "Security Inbox rule is ready.";
    }
    throw new Error(detail || saved.statusText);
  }
  return "Security Inbox rule is ready.";
}

const RULE_PAGE_SIZE = 100;
const RULE_PAGE_LIMIT = 20;

async function findRule(
  api: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ id?: string; name?: string; version?: number } | undefined> {
  for (let page = 0; page < RULE_PAGE_LIMIT; page += 1) {
    const listed = await fetchImpl(
      `${api}/api/v2/security_monitoring/rules?page[size]=${RULE_PAGE_SIZE}&page[number]=${page}`,
      { headers },
    );
    const listedText = await listed.text();
    if (!listed.ok) {
      throw new Error(listedText.slice(0, 300) || listed.statusText);
    }
    const rules = rulesFrom(parseJson(listedText));
    const match = rules.find((rule) => rule.name === SIGNAL_TITLE);
    if (match || rules.length < RULE_PAGE_SIZE) {
      return match;
    }
  }
  return undefined;
}

function parseJson(value: string): unknown {
  if (!value.trim()) {
    return {};
  }
  return JSON.parse(value) as unknown;
}

function rulesFrom(body: unknown): Array<{ id?: string; name?: string; version?: number }> {
  if (!body || typeof body !== "object") {
    return [];
  }
  const data = (body as { data?: unknown }).data;
  const list = Array.isArray(data) ? data : Array.isArray(body) ? body : [];
  return list.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as { id?: unknown; name?: unknown; version?: unknown; attributes?: unknown };
    const attributes =
      record.attributes && typeof record.attributes === "object"
        ? (record.attributes as { name?: unknown; version?: unknown })
        : undefined;
    const name = typeof attributes?.name === "string" ? attributes.name : record.name;
    const version = typeof attributes?.version === "number" ? attributes.version : record.version;
    return [
      {
        id: typeof record.id === "string" ? record.id : undefined,
        name: typeof name === "string" ? name : undefined,
        version: typeof version === "number" ? version : undefined,
      },
    ];
  });
}
