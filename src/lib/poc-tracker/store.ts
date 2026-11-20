import fs from "node:fs";
import path from "node:path";

import { resolveAgentForgeDataDir } from "@/lib/db/store";
import type { WebhookLogEntry, WebhookStore } from "@/lib/readonly-account/asana-webhook";
import { getSafPocStore, type SafPocStore } from "@/lib/saf-poc/storage";

export const DEFAULT_POC_PROJECT_NAME = "POC Gateway - Request Management";
export const POC_TRACKER_WEBHOOK_PATH = "/api/poc-tracker/asana/webhook";

const STATE_KEY = "POC_TRACKER#config";
const LOG_LIMIT = 50;

export type PocTrackerConfig = {
  asanaToken: string;
  slackBotToken: string;
  projectName: string;
  channelId: string;
  secret: string;
  projectGid: string;
  webhookGid: string;
  log: WebhookLogEntry[];
};

export type PocTrackerPublic = {
  asanaTokenSet: boolean;
  slackTokenSource: "saved" | "environment" | "missing";
  projectName: string;
  projectGid: string;
  webhookGid: string;
  channelId: string;
  log: WebhookLogEntry[];
};

export function defaultPocTracker(): PocTrackerConfig {
  return {
    asanaToken: "",
    slackBotToken: "",
    projectName: DEFAULT_POC_PROJECT_NAME,
    channelId: "",
    secret: "",
    projectGid: "",
    webhookGid: "",
    log: [],
  };
}

export function pocTrackerPublic(config: PocTrackerConfig): PocTrackerPublic {
  const channelId =
    config.channelId.trim() || process.env.SLACK_POC_CHANNEL_ID?.trim() || "C0CK03K8QF3";
  return {
    asanaTokenSet: Boolean(config.asanaToken.trim()),
    slackTokenSource: config.slackBotToken.trim()
      ? "saved"
      : process.env.SLACK_BOT_TOKEN?.trim()
        ? "environment"
        : "missing",
    projectName: config.projectName,
    projectGid: config.projectGid,
    webhookGid: config.webhookGid,
    channelId,
    log: config.log,
  };
}

export function pocTrackerStorage(): { storage: "dynamodb" | "local"; storedAt: string } {
  if (process.env.SAF_POC_TABLE_NAME?.trim()) {
    return { storage: "dynamodb", storedAt: process.env.SAF_POC_TABLE_NAME.trim() };
  }
  return { storage: "local", storedAt: "" };
}

let memoryState: PocTrackerConfig | null = null;
let storeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = storeChain.then(operation, operation);
  storeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function trackerPath(): string {
  return path.join(resolveAgentForgeDataDir(), "poc-tracker.json");
}

function normalize(config: Partial<PocTrackerConfig> | null | undefined): PocTrackerConfig {
  const defaults = defaultPocTracker();
  return {
    asanaToken: config?.asanaToken?.trim() ?? "",
    slackBotToken: config?.slackBotToken?.trim() ?? "",
    projectName: config?.projectName?.trim() || defaults.projectName,
    channelId: config?.channelId?.trim() ?? "",
    secret: config?.secret?.trim() ?? "",
    projectGid: config?.projectGid?.trim() ?? "",
    webhookGid: config?.webhookGid?.trim() ?? "",
    log: Array.isArray(config?.log) ? config.log.slice(-LOG_LIMIT) : [],
  };
}

export async function loadPocTracker(store?: SafPocStore | null): Promise<PocTrackerConfig> {
  return enqueue(() => readPocTracker(store));
}

export async function savePocTracker(
  input: Partial<PocTrackerConfig>,
  store?: SafPocStore | null,
): Promise<PocTrackerConfig> {
  return enqueue(() => writePocTracker(input, store));
}

export async function appendPocTrackerLog(message: string, store?: SafPocStore | null): Promise<void> {
  await enqueue(async () => {
    const current = await readPocTracker(store);
    const log = [...current.log, { at: new Date().toISOString(), message }].slice(-LOG_LIMIT);
    await persist({ ...current, log }, store);
  });
}

export function pocTrackerWebhookStore(store?: SafPocStore | null): WebhookStore {
  return {
    async load() {
      const state = await loadPocTracker(store);
      return {
        secret: state.secret,
        sectionGid: "",
        projectGid: state.projectGid,
        webhookGid: state.webhookGid,
        log: state.log,
      };
    },
    async update(patch) {
      const input: Partial<PocTrackerConfig> = {};
      if (patch.secret !== undefined) {
        input.secret = patch.secret;
      }
      if (patch.projectGid !== undefined) {
        input.projectGid = patch.projectGid;
      }
      if (patch.webhookGid !== undefined) {
        input.webhookGid = patch.webhookGid;
      }
      if (patch.log !== undefined) {
        input.log = patch.log;
      }
      const next = await savePocTracker(input, store);
      return {
        secret: next.secret,
        sectionGid: "",
        projectGid: next.projectGid,
        webhookGid: next.webhookGid,
        log: next.log,
      };
    },
  };
}

async function readPocTracker(store?: SafPocStore | null): Promise<PocTrackerConfig> {
  if (memoryState && store === undefined) {
    return memoryState;
  }
  const shared = resolveStore(store);
  if (shared) {
    const stored = await shared.get<Partial<PocTrackerConfig>>(STATE_KEY);
    if (stored) {
      const state = normalize(stored);
      if (store === undefined) {
        memoryState = state;
      }
      return state;
    }
  }
  const filePath = trackerPath();
  if (!fs.existsSync(filePath)) {
    return defaultPocTracker();
  }
  try {
    const state = normalize(JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PocTrackerConfig>);
    if (store === undefined) {
      memoryState = state;
    }
    return state;
  } catch {
    return defaultPocTracker();
  }
}

async function writePocTracker(
  input: Partial<PocTrackerConfig>,
  store?: SafPocStore | null,
): Promise<PocTrackerConfig> {
  const current = await readPocTracker(store);
  const next = normalize({
    ...current,
    ...input,
    asanaToken: input.asanaToken?.trim() || current.asanaToken,
    slackBotToken: input.slackBotToken?.trim() || current.slackBotToken,
    log: input.log ?? current.log,
  });
  await persist(next, store);
  return next;
}

async function persist(next: PocTrackerConfig, store?: SafPocStore | null): Promise<void> {
  if (store === undefined) {
    memoryState = next;
  }
  const shared = resolveStore(store);
  if (!shared && process.env.AWS_EXECUTION_ENV?.trim()) {
    throw new Error(
      "Set SAF_POC_TABLE_NAME in Amplify and redeploy so SAF POC Tracker is kept. A file on this server is erased on every deploy.",
    );
  }
  if (shared) {
    await shared.put(STATE_KEY, next);
  }
  const filePath = trackerPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next));
  } catch (error) {
    if (!shared) {
      throw error;
    }
  }
}

function resolveStore(store?: SafPocStore | null): SafPocStore | null {
  if (store === null) {
    return null;
  }
  if (store) {
    return store;
  }
  if (!process.env.SAF_POC_TABLE_NAME?.trim()) {
    return null;
  }
  return getSafPocStore();
}
