import type { SafPocStore } from "@/lib/saf-poc/storage";
import { getSafPocStore } from "@/lib/saf-poc/storage";

const ASANA_API = "https://app.asana.com/api/1.0";
const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";
const TASK_GID = /^[0-9]{5,20}$/;
const THREAD_TS = /^\d+\.\d+$/;
const DEDUP_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

export const DEFAULT_SLACK_POC_CHANNEL_ID = "C0CK03K8QF3";

const TASK_FIELDS = [
  "name",
  "projects.gid",
  "memberships.project.gid",
  "memberships.section.name",
  "custom_fields.name",
  "custom_fields.display_value",
  "custom_fields.text_value",
  "custom_fields.enum_value.name",
].join(",");

type Stage = {
  aliases: string[];
  label: string;
  text: (customer: string) => string;
};

const STAGES: Stage[] = [
  {
    aliases: ["active provisioning", "provisioning active"],
    label: "Active Provisioning",
    text: (customer) =>
      `⚡ *Status Update: Active Provisioning*\n_TES team has picked up the request for *${customer}*. Environment sandbox is currently being provisioned._`,
  },
  {
    aliases: ["implemented / live"],
    label: "Implemented / Live",
    text: (customer) =>
      `🟢 *Status Update: Implemented / Live*\n🎉 _The POC environment for *${customer}* is now live! Secure credentials have been delivered via Slack DM._`,
  },
  {
    aliases: ["completed"],
    label: "Completed",
    text: (customer) =>
      `🏁 *Status Update: Completed*\n_The POC engagement for *${customer}* has been marked as completed. Environment is scheduled for clean tear-down._`,
  },
  {
    aliases: ["rejected"],
    label: "Rejected",
    text: (customer) =>
      `❌ *Status Update: Rejected*\n_This POC request for *${customer}* has been closed/rejected._`,
  },
];

type AsanaEvent = {
  action?: string;
  resource?: { gid?: string; resource_type?: string };
};

type AsanaCustomField = {
  name?: string;
  display_value?: string | null;
  text_value?: string | null;
  enum_value?: { name?: string } | null;
};

type AsanaTask = {
  name?: string;
  projects?: Array<{ gid?: string }>;
  memberships?: Array<{ project?: { gid?: string }; section?: { name?: string } }>;
  custom_fields?: AsanaCustomField[];
};

type DedupRecord = {
  postedAt: number;
};

export type SlackDeliveryStatus =
  | "posted"
  | "deduplicated"
  | "skipped_status"
  | "skipped_thread_ts"
  | "skipped_project"
  | "skipped_no_project"
  | "missing_slack_credentials"
  | "missing_asana_token"
  | "task_fetch_failed"
  | "slack_rejected";

export type SlackSyncResult = {
  taskGid: string;
  targetStatus: string;
  slackThreadTs: string;
  deliveryStatus: SlackDeliveryStatus;
};

export type SlackSyncOptions = {
  asanaToken: string;
  projectGid: string;
  fetchImpl?: typeof fetch;
  store?: SafPocStore | null;
  now?: () => number;
  cache?: Map<string, number>;
  slackToken?: string;
  channelId?: string;
};

const processCache = new Map<string, number>();

export function taskGidsForSlackSync(events: unknown): string[] {
  if (!Array.isArray(events)) {
    return [];
  }
  const gids = new Set<string>();
  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }
    const record = event as AsanaEvent;
    if (record.action !== "added" && record.action !== "changed") {
      continue;
    }
    const gid = record.resource?.gid ?? "";
    if (record.resource?.resource_type === "task" && TASK_GID.test(gid)) {
      gids.add(gid);
    }
  }
  return [...gids];
}

export function taskGidsForSignedDelivery(status: number, body: string): string[] {
  if (status !== 200) {
    return [];
  }
  const trimmed = body.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const payload = JSON.parse(trimmed) as { events?: unknown };
    return taskGidsForSlackSync(payload.events);
  } catch {
    return [];
  }
}

export function slackPocChannelId(override?: string): string {
  const fromOverride = override?.trim();
  if (fromOverride) {
    return fromOverride;
  }
  return process.env.SLACK_POC_CHANNEL_ID?.trim() || DEFAULT_SLACK_POC_CHANNEL_ID;
}

export function describeSlackSyncResult(result: SlackSyncResult): string {
  const task = result.taskGid ? `Task ${result.taskGid}` : "Slack sync";
  switch (result.deliveryStatus) {
    case "posted":
      return `${task} is ${result.targetStatus}. Posted to the Slack thread.`;
    case "deduplicated":
      return `${task} is ${result.targetStatus}. Already posted in the last minute.`;
    case "skipped_status":
      return `${task} is in "${result.targetStatus || "blank"}". No Slack reply for this stage.`;
    case "skipped_thread_ts":
      return `${task} is in "${result.targetStatus || "blank"}". Slack thread timestamp is missing or invalid.`;
    case "skipped_project":
      return `${task} is not in this Asana project.`;
    case "skipped_no_project":
      return "Slack sync skipped. The POC Tracker project is not connected.";
    case "missing_slack_credentials":
      return "Slack bot token is not set. No reply was posted.";
    case "missing_asana_token":
      return "Asana access token is not set. No reply was posted.";
    case "task_fetch_failed":
      return `${task} could not be read from Asana.`;
    case "slack_rejected":
      return `${task} is ${result.targetStatus}. Slack rejected the reply.`;
    default:
      return `${task} sync finished with ${result.deliveryStatus}.`;
  }
}

export async function syncAsanaSlackStatus(taskGids: string[], options: SlackSyncOptions): Promise<SlackSyncResult[]> {
  const now = options.now ?? Date.now;
  const results: SlackSyncResult[] = [];
  const slackToken = resolveSlackToken(options);
  if (!slackToken) {
    logSlackSync(results, "missing_slack_credentials", {}, now);
    return results;
  }
  if (!options.asanaToken.trim()) {
    logSlackSync(results, "missing_asana_token", {}, now);
    return results;
  }
  const projectGid = options.projectGid.trim();
  if (!projectGid) {
    logSlackSync(results, "skipped_no_project", {}, now);
    return results;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const store = resolveStore(options.store);
  const cache = options.cache ?? processCache;
  const channel = slackPocChannelId(options.channelId);

  for (const taskGid of taskGids) {
    if (!TASK_GID.test(taskGid)) {
      continue;
    }
    await syncTask({
      taskGid,
      asanaToken: options.asanaToken.trim(),
      projectGid,
      slackToken,
      channel,
      fetchImpl,
      store,
      cache,
      now,
      results,
    });
  }
  return results;
}

async function syncTask(input: {
  taskGid: string;
  asanaToken: string;
  projectGid: string;
  slackToken: string;
  channel: string;
  fetchImpl: typeof fetch;
  store: SafPocStore | null;
  cache: Map<string, number>;
  now: () => number;
  results: SlackSyncResult[];
}): Promise<void> {
  let task: AsanaTask;
  try {
    task = await fetchTask(input.fetchImpl, input.asanaToken, input.taskGid);
  } catch {
    logSlackSync(input.results, "task_fetch_failed", { taskGid: input.taskGid }, input.now);
    return;
  }

  if (!taskInProject(task, input.projectGid)) {
    logSlackSync(input.results, "skipped_project", { taskGid: input.taskGid }, input.now);
    return;
  }

  const fields = task.custom_fields ?? [];
  const threadTs = customFieldValue(fields, "Slack Thread TS");
  const pocStatus = customFieldValue(fields, "POC Status");
  const status = pocStatus || sectionName(task, input.projectGid);
  if (!threadTs || !THREAD_TS.test(threadTs)) {
    logSlackSync(input.results, "skipped_thread_ts", { taskGid: input.taskGid, targetStatus: status }, input.now);
    return;
  }

  const stage = stageFor(status);
  if (!stage) {
    logSlackSync(input.results, "skipped_status", { taskGid: input.taskGid, targetStatus: status, slackThreadTs: threadTs }, input.now);
    return;
  }

  const dedupKey = `ASANA_SLACK_SYNC#${input.taskGid}#${stage.label.toLowerCase()}`;
  const at = input.now();
  if (await postedRecently(input.cache, input.store, dedupKey, at)) {
    logSlackSync(input.results, "deduplicated", { taskGid: input.taskGid, targetStatus: stage.label, slackThreadTs: threadTs }, input.now);
    return;
  }
  remember(input.cache, dedupKey, at);
  await writePostedAt(input.store, dedupKey, at);

  const customer = sanitizeSlackText(customFieldValue(fields, "Customer") || task.name?.trim() || "POC Request");
  const text = stage.text(customer);
  try {
    const posted = await postSlack(input.fetchImpl, input.slackToken, input.channel, threadTs, text);
    logSlackSync(input.results, posted ? "posted" : "slack_rejected", {
      taskGid: input.taskGid,
      targetStatus: stage.label,
      slackThreadTs: threadTs,
    }, input.now);
  } catch {
    logSlackSync(input.results, "slack_rejected", {
      taskGid: input.taskGid,
      targetStatus: stage.label,
      slackThreadTs: threadTs,
    }, input.now);
  }
}

function stageFor(status: string): Stage | null {
  const normalized = status.trim().toLowerCase();
  return STAGES.find((stage) => stage.aliases.includes(normalized)) ?? null;
}

function taskInProject(task: AsanaTask, projectGid: string): boolean {
  if ((task.projects ?? []).some((project) => project.gid === projectGid)) {
    return true;
  }
  return (task.memberships ?? []).some((membership) => membership.project?.gid === projectGid);
}

function sectionName(task: AsanaTask, projectGid: string): string {
  const memberships = task.memberships ?? [];
  const inProject = memberships.find((membership) => membership.project?.gid === projectGid);
  return ((inProject ?? memberships[0])?.section?.name ?? "").trim();
}

function customFieldValue(fields: AsanaCustomField[], name: string): string {
  const wanted = name.trim().toLowerCase();
  const field = fields.find((item) => (item.name ?? "").trim().toLowerCase() === wanted);
  if (!field) {
    return "";
  }
  const enumName = field.enum_value?.name?.trim() ?? "";
  if (enumName) {
    return enumName;
  }
  const display = field.display_value?.trim() ?? "";
  if (display) {
    return display;
  }
  return field.text_value?.trim() ?? "";
}

function sanitizeSlackText(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function resolveSlackToken(options: SlackSyncOptions): string {
  if (options.slackToken !== undefined) {
    return options.slackToken.trim();
  }
  return process.env.SLACK_BOT_TOKEN?.trim() || "";
}

function resolveStore(store: SafPocStore | null | undefined): SafPocStore | null {
  if (store === null) {
    return null;
  }
  if (store) {
    return store;
  }
  return getSafPocStore();
}

async function fetchTask(fetchImpl: typeof fetch, token: string, taskGid: string): Promise<AsanaTask> {
  const params = new URLSearchParams({ opt_fields: TASK_FIELDS });
  const response = await fetchImpl(`${ASANA_API}/tasks/${taskGid}?${params}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload: { data?: AsanaTask } = {};
  if (text) {
    payload = JSON.parse(text) as { data?: AsanaTask };
  }
  if (!response.ok || !payload.data) {
    throw new Error("Asana task fetch failed.");
  }
  return payload.data;
}

async function postSlack(
  fetchImpl: typeof fetch,
  token: string,
  channel: string,
  threadTs: string,
  text: string,
): Promise<boolean> {
  const response = await fetchImpl(SLACK_POST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await response.text();
  let payload: { ok?: boolean } = {};
  if (raw) {
    payload = JSON.parse(raw) as { ok?: boolean };
  }
  return response.ok && payload.ok === true;
}

async function postedRecently(
  cache: Map<string, number>,
  store: SafPocStore | null,
  key: string,
  at: number,
): Promise<boolean> {
  const cached = cache.get(key);
  if (cached !== undefined && at - cached < DEDUP_TTL_MS) {
    return true;
  }
  if (!store) {
    return false;
  }
  try {
    const record = await store.get<DedupRecord>(key);
    if (typeof record?.postedAt === "number" && at - record.postedAt < DEDUP_TTL_MS) {
      cache.set(key, record.postedAt);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function remember(cache: Map<string, number>, key: string, at: number): void {
  for (const [existing, postedAt] of cache) {
    if (at - postedAt >= DEDUP_TTL_MS) {
      cache.delete(existing);
    }
  }
  cache.set(key, at);
}

async function writePostedAt(store: SafPocStore | null, key: string, at: number): Promise<void> {
  if (!store) {
    return;
  }
  try {
    await store.put(key, { postedAt: at } satisfies DedupRecord);
  } catch {
    // The in-process cache still blocks a retry on this server.
  }
}

function logSlackSync(
  results: SlackSyncResult[],
  deliveryStatus: SlackDeliveryStatus,
  details: { taskGid?: string; targetStatus?: string; slackThreadTs?: string },
  now: () => number,
): void {
  const result: SlackSyncResult = {
    taskGid: details.taskGid ?? "",
    targetStatus: details.targetStatus ?? "",
    slackThreadTs: details.slackThreadTs ?? "",
    deliveryStatus,
  };
  results.push(result);
  console.log(
    JSON.stringify({
      timestamp: new Date(now()).toISOString(),
      taskGid: result.taskGid,
      targetStatus: result.targetStatus,
      slackThreadTs: result.slackThreadTs,
      deliveryStatus,
    }),
  );
}
