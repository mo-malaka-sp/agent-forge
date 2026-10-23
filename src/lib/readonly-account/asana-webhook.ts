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

const STASH_TASK_NAME = "AgentForge webhook";
const STASH_PENDING = "pending";

type AsanaRecord = {
  gid?: string;
  name?: string;
  notes?: string;
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
  input: {
    hookSecret: string | null;
    signature: string | null;
    body: string;
    sectionGid?: string;
    stashGid?: string;
  },
  options: {
    store: WebhookStore;
    accept?: (taskGid: string) => Promise<unknown>;
    readSecret?: (stashGid: string) => Promise<string>;
    writeSecret?: (stashGid: string, secret: string) => Promise<void>;
  },
): Promise<WebhookReceipt> {
  const sectionGid = input.sectionGid?.trim() ?? "";
  const stashGid = input.stashGid?.trim() ?? "";
  if (input.hookSecret) {
    if (!stashGid || !options.writeSecret) {
      return { status: 500, headers: {}, body: { error: "Webhook handshake could not be stored." } };
    }
    await options.writeSecret(stashGid, input.hookSecret);
    await options.store.update({
      secret: input.hookSecret,
      ...(sectionGid ? { sectionGid } : {}),
    });
    return { status: 200, headers: { "X-Hook-Secret": input.hookSecret }, body: null };
  }

  const state = await options.store.load();
  let secret = state?.secret ?? "";
  if (!asanaSignatureMatches(input.body, secret, input.signature) && stashGid && options.readSecret) {
    secret = await options.readSecret(stashGid);
    if (secret && secret !== STASH_PENDING) {
      await options.store.update({
        secret,
        ...(sectionGid || state?.sectionGid ? { sectionGid: sectionGid || state?.sectionGid } : {}),
      });
    }
  }
  if (!secret || !asanaSignatureMatches(input.body, secret, input.signature)) {
    return { status: 401, headers: {}, body: { error: "Webhook signature was rejected." } };
  }
  const readySection = sectionGid || state?.sectionGid || "";

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
  if (!readySection) {
    return { status: 500, headers: {}, body: { error: "The Ready for TES webhook is not registered." } };
  }

  const accepted = taskGidsMovedToSection(events, readySection);
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
  const hooks = await listRecords(token, `/webhooks?workspace=${workspaceGid}&limit=100`, fetchImpl);
  const stashGid = stashGidFromHooks(hooks) || (await createStashTask(token, workspaceGid, fetchImpl));
  const targetUrl = webhookTarget(options.targetUrl, sectionGid, stashGid);
  await options.store.update({ projectGid, sectionGid });
  for (const hook of hooks) {
    if (hook.gid && hook.target?.includes("/api/readonly-account/asana/webhook")) {
      await asana(token, `/webhooks/${hook.gid}`, fetchImpl, { method: "DELETE" });
    }
  }
  const created = oneRecord(
    await asana(token, "/webhooks", fetchImpl, {
      method: "POST",
      body: JSON.stringify({
        data: {
          resource: projectGid,
          target: targetUrl,
          filters: [{ resource_type: "task", action: "added" }],
        },
      }),
    }),
  );
  const webhookGid = created.gid ?? "";
  if (!webhookGid) {
    throw new Error("Asana did not return a webhook id.");
  }
  const secret = await readStashSecret(token, stashGid, fetchImpl);
  if (!secret || secret === STASH_PENDING) {
    throw new Error("Asana did not complete the webhook handshake.");
  }
  await options.store.update({ webhookGid, secret, sectionGid, projectGid });
  return {
    projectName: project.name || projectName,
    sectionName,
    projectGid,
    sectionGid,
    webhookGid,
    targetUrl,
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

function webhookTarget(baseUrl: string, sectionGid: string, stashGid: string): string {
  const target = new URL(baseUrl);
  target.searchParams.set("section", sectionGid);
  target.searchParams.set("stash", stashGid);
  return target.toString();
}

function stashGidFromHooks(hooks: AsanaRecord[]): string {
  for (const hook of hooks) {
    if (!hook.target?.includes("/api/readonly-account/asana/webhook")) {
      continue;
    }
    try {
      const stash = new URL(hook.target).searchParams.get("stash")?.trim() ?? "";
      if (stash) {
        return stash;
      }
    } catch {
      continue;
    }
  }
  return "";
}

async function createStashTask(token: string, workspaceGid: string, fetchImpl: typeof fetch): Promise<string> {
  const created = oneRecord(
    await asana(token, "/tasks", fetchImpl, {
      method: "POST",
      body: JSON.stringify({
        data: {
          workspace: workspaceGid,
          name: STASH_TASK_NAME,
          notes: STASH_PENDING,
          completed: true,
        },
      }),
    }),
  );
  if (!created.gid) {
    throw new Error("Asana did not store the webhook handshake.");
  }
  return created.gid;
}

export async function readStashSecret(
  token: string,
  stashGid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const task = oneRecord(await asana(token, `/tasks/${stashGid}?opt_fields=notes`, fetchImpl));
  return task.notes?.trim() ?? "";
}

export async function writeStashSecret(
  token: string,
  stashGid: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await asana(token, `/tasks/${stashGid}`, fetchImpl, {
    method: "PUT",
    body: JSON.stringify({ data: { notes: secret } }),
  });
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
  const current = await readStoredWebhookState(filePath);
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
