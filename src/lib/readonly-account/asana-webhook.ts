import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveAgentForgeDataDir } from "@/lib/db/store";
import { getSafPocStore } from "@/lib/saf-poc/storage";

const ASANA_API = "https://app.asana.com/api/1.0";
const TASK_GID = /^[0-9]{5,20}$/;
const WEBHOOK_KEY = "READONLY_ACCOUNT#asana-webhook";

export const DEFAULT_ASANA_PROJECT_NAME = "POC Gateway - Request Management";
export const DEFAULT_ASANA_SECTION_NAME = "Ready for TES";

export type AsanaWebhookState = {
  secret: string;
  sectionGid: string;
  projectGid: string;
  webhookGid: string;
};

export type WebhookStore = {
  load(): Promise<AsanaWebhookState | null>;
  update(patch: Partial<AsanaWebhookState>): Promise<AsanaWebhookState>;
};

type AsanaEvent = {
  action?: string;
  resource?: { gid?: string; resource_type?: string };
  parent?: { gid?: string; resource_type?: string };
};

type AsanaRecord = {
  gid?: string;
  name?: string;
  archived?: boolean;
  target?: string;
  resource?: { gid?: string };
  workspace?: { gid?: string };
};

type AsanaBody = {
  data?: AsanaRecord | AsanaRecord[];
  next_page?: { offset?: string } | null;
  errors?: Array<{ message?: string }>;
};

export type WebhookReceipt = {
  status: number;
  headers: Record<string, string>;
  body: { ok?: boolean; accepted?: string[]; error?: string } | null;
};

const EMPTY_STATE: AsanaWebhookState = {
  secret: "",
  sectionGid: "",
  projectGid: "",
  webhookGid: "",
};

let memoryState: AsanaWebhookState | null = null;
let storeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = storeChain.then(operation, operation);
  storeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function memoryWebhookStore(initial: AsanaWebhookState | null = null): WebhookStore {
  let state = initial;
  return {
    async load() {
      return state;
    },
    async update(patch) {
      state = { ...EMPTY_STATE, ...state, ...patch };
      return state;
    },
  };
}

export function defaultWebhookStore(): WebhookStore {
  const filePath = path.join(resolveAgentForgeDataDir(), "readonly-account-asana-webhook.json");
  return {
    load: () => enqueue(() => readWebhookState(filePath)),
    update: (patch) => enqueue(() => writeWebhookState(filePath, patch)),
  };
}

export function taskGidsMovedToSection(events: unknown, sectionGid: string): string[] {
  if (!Array.isArray(events) || !sectionGid) {
    return [];
  }
  const gids = new Set<string>();
  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }
    const record = event as AsanaEvent;
    const gid = record.resource?.gid ?? "";
    if (
      record.action === "added" &&
      record.resource?.resource_type === "task" &&
      record.parent?.resource_type === "section" &&
      record.parent.gid === sectionGid &&
      TASK_GID.test(gid)
    ) {
      gids.add(gid);
    }
  }
  return [...gids];
}

export function asanaSignatureMatches(body: string, secret: string, signature: string | null): boolean {
  if (!secret || !signature) {
    return false;
  }
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"));
  const provided = Buffer.from(signature.trim());
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export async function receiveAsanaWebhook(
  input: { hookSecret: string | null; signature: string | null; body: string },
  options: {
    store: WebhookStore;
    accept?: (taskGid: string) => Promise<unknown>;
  },
): Promise<WebhookReceipt> {
  if (input.hookSecret) {
    await options.store.update({ secret: input.hookSecret });
    return { status: 200, headers: { "X-Hook-Secret": input.hookSecret }, body: null };
  }

  const state = await options.store.load();
  if (!state?.secret || !asanaSignatureMatches(input.body, state.secret, input.signature)) {
    return { status: 401, headers: {}, body: { error: "Webhook signature was rejected." } };
  }

  let payload: { events?: unknown };
  try {
    payload = input.body ? (JSON.parse(input.body) as { events?: unknown }) : {};
  } catch {
    return { status: 400, headers: {}, body: { error: "Webhook body must be valid JSON." } };
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  if (events.length === 0) {
    return { status: 200, headers: {}, body: { ok: true, accepted: [] } };
  }
  if (!state.sectionGid) {
    return { status: 500, headers: {}, body: { error: "The Ready for TES webhook is not registered." } };
  }

  const accepted = taskGidsMovedToSection(events, state.sectionGid);
  for (const taskGid of accepted) {
    await options.accept?.(taskGid);
  }
  return { status: 200, headers: {}, body: { ok: true, accepted } };
}

export async function registerReadySectionWebhook(options: {
  token?: string;
  targetUrl: string;
  fetchImpl?: typeof fetch;
  store: WebhookStore;
  projectName?: string;
  projectGid?: string;
  sectionName?: string;
}): Promise<{
  projectName: string;
  sectionName: string;
  projectGid: string;
  sectionGid: string;
  webhookGid: string;
  targetUrl: string;
}> {
  const token = options.token?.trim() || process.env.ASANA_ACCESS_TOKEN?.trim() || "";
  if (!token) {
    throw new Error("Set ASANA_ACCESS_TOKEN to the Asana personal access token.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const projectName = options.projectName?.trim() || process.env.ASANA_PROJECT_NAME?.trim() || DEFAULT_ASANA_PROJECT_NAME;
  const sectionName = options.sectionName?.trim() || process.env.ASANA_READY_SECTION?.trim() || DEFAULT_ASANA_SECTION_NAME;
  const projectGid =
    options.projectGid?.trim() ||
    process.env.ASANA_PROJECT_GID?.trim() ||
    (await findProjectGid(token, projectName, fetchImpl));
  const project = oneRecord(
    await asana(token, `/projects/${projectGid}?opt_fields=name,workspace,workspace.name`, fetchImpl),
  );
  const workspaceGid = project.workspace?.gid ?? "";
  if (!workspaceGid) {
    throw new Error("Asana did not return the project workspace.");
  }
  const sectionGid = await findSectionGid(token, projectGid, sectionName, fetchImpl);
  await options.store.update({ projectGid, sectionGid });
  await deleteWebhooksForTarget(token, workspaceGid, options.targetUrl, fetchImpl);
  const created = oneRecord(
    await asana(token, "/webhooks", fetchImpl, {
      method: "POST",
      body: JSON.stringify({
        data: {
          resource: projectGid,
          target: options.targetUrl,
          filters: [{ resource_type: "task", action: "added" }],
        },
      }),
    }),
  );
  const webhookGid = created.gid ?? "";
  if (!webhookGid) {
    throw new Error("Asana did not return a webhook id.");
  }
  const saved = await options.store.update({ webhookGid });
  if (!saved.secret) {
    throw new Error("Asana did not complete the webhook handshake.");
  }
  return {
    projectName: project.name || projectName,
    sectionName,
    projectGid,
    sectionGid,
    webhookGid,
    targetUrl: options.targetUrl,
  };
}

async function findProjectGid(token: string, projectName: string, fetchImpl: typeof fetch): Promise<string> {
  const workspaces = await listRecords(token, "/workspaces?opt_fields=name&limit=100", fetchImpl);
  for (const workspace of workspaces) {
    if (!workspace.gid) {
      continue;
    }
    const projects = await listRecords(
      token,
      `/workspaces/${workspace.gid}/projects?opt_fields=name,archived&archived=false&limit=100`,
      fetchImpl,
    );
    const match = projects.find((project) => project.name === projectName && project.archived !== true);
    if (match?.gid) {
      return match.gid;
    }
  }
  throw new Error(`Asana project ${projectName} was not found.`);
}

async function findSectionGid(
  token: string,
  projectGid: string,
  sectionName: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const sections = await listRecords(
    token,
    `/projects/${projectGid}/sections?opt_fields=name&limit=100`,
    fetchImpl,
  );
  const match = sections.find((section) => section.name === sectionName);
  if (!match?.gid) {
    throw new Error(`Asana section ${sectionName} was not found.`);
  }
  return match.gid;
}

async function deleteWebhooksForTarget(
  token: string,
  workspaceGid: string,
  targetUrl: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const hooks = await listRecords(token, `/webhooks?workspace=${workspaceGid}&limit=100`, fetchImpl);
  for (const hook of hooks) {
    if (hook.target === targetUrl && hook.gid) {
      await asana(token, `/webhooks/${hook.gid}`, fetchImpl, { method: "DELETE" });
    }
  }
}

async function listRecords(token: string, firstPath: string, fetchImpl: typeof fetch): Promise<AsanaRecord[]> {
  const records: AsanaRecord[] = [];
  let nextPath: string | null = firstPath;
  while (nextPath) {
    const page = await asana(token, nextPath, fetchImpl);
    records.push(...(Array.isArray(page.data) ? page.data : []));
    const offset = page.next_page?.offset;
    nextPath = offset ? withOffset(firstPath, offset) : null;
  }
  return records;
}

function withOffset(pathAndQuery: string, offset: string): string {
  const join = pathAndQuery.includes("?") ? "&" : "?";
  return `${pathAndQuery}${join}offset=${encodeURIComponent(offset)}`;
}

function oneRecord(body: AsanaBody): AsanaRecord {
  return body.data && !Array.isArray(body.data) ? body.data : {};
}

async function asana(
  token: string,
  pathAndQuery: string,
  fetchImpl: typeof fetch,
  init: RequestInit = {},
): Promise<AsanaBody> {
  const response = await fetchImpl(`${ASANA_API}${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  let payload: AsanaBody = {};
  if (text) {
    try {
      payload = JSON.parse(text) as AsanaBody;
    } catch {
      payload = {};
    }
  }
  if (!response.ok) {
    throw new Error(payload.errors?.[0]?.message ?? `Asana request failed (${response.status}).`);
  }
  return payload;
}

async function readWebhookState(filePath: string): Promise<AsanaWebhookState | null> {
  if (memoryState) {
    return memoryState;
  }
  if (process.env.SAF_POC_TABLE_NAME?.trim()) {
    const stored = await getSafPocStore().get<AsanaWebhookState>(WEBHOOK_KEY);
    if (stored?.sectionGid || stored?.secret) {
      memoryState = { ...EMPTY_STATE, ...stored };
      return memoryState;
    }
  }
  if (!fs.existsSync(filePath)) {
    return null;
  }
  memoryState = { ...EMPTY_STATE, ...(JSON.parse(fs.readFileSync(filePath, "utf8")) as AsanaWebhookState) };
  return memoryState;
}

async function writeWebhookState(
  filePath: string,
  patch: Partial<AsanaWebhookState>,
): Promise<AsanaWebhookState> {
  const current = memoryState ?? (await readStoredWebhookState(filePath));
  memoryState = { ...EMPTY_STATE, ...current, ...patch };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(memoryState));
  if (process.env.SAF_POC_TABLE_NAME?.trim()) {
    await getSafPocStore().put(WEBHOOK_KEY, memoryState);
  }
  return memoryState;
}

async function readStoredWebhookState(filePath: string): Promise<AsanaWebhookState | null> {
  if (process.env.SAF_POC_TABLE_NAME?.trim()) {
    const stored = await getSafPocStore().get<AsanaWebhookState>(WEBHOOK_KEY);
    if (stored) {
      return { ...EMPTY_STATE, ...stored };
    }
  }
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return { ...EMPTY_STATE, ...(JSON.parse(fs.readFileSync(filePath, "utf8")) as AsanaWebhookState) };
}
