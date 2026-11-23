import fs from "node:fs";
import path from "node:path";

import { resolveAgentForgeDataDir } from "@/lib/db/store";
import { ensureLegacyTenantsMigrated } from "@/lib/isc/profiles-store";
import { readonlyAccountClient } from "@/lib/readonly-account/tenant";
import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { getSafPocStore, type SafPocStore } from "@/lib/saf-poc/storage";

/**
 * The SailPoint tenant is not stored here. Test Drive uses the saved tenant bound to the
 * "test-drive" feature (see `src/lib/isc/profiles-store.ts`).
 */
export type AsanaDeskConfig = {
  asanaToken: string;
  projectName: string;
  triggerStatus: string;
  workingStatus: string;
  doneStatus: string;
  declinedStatus: string;
  accountField: string;
  codeField: string;
  tenantLinkField: string;
  tenantLinkTemplate: string;
};

export type AsanaDeskPublic = Omit<AsanaDeskConfig, "asanaToken"> & {
  asanaTokenSet: boolean;
};

export function defaultAsanaDesk(): AsanaDeskConfig {
  return {
    asanaToken: "",
    projectName: "Test Drive Requests - Testing",
    triggerStatus: "New request",
    workingStatus: "Evaluation",
    doneStatus: "Implemented",
    declinedStatus: "Declined",
    accountField: "Sandbox account",
    codeField: "Initial password",
    tenantLinkField: "",
    tenantLinkTemplate: "https://{tenant}.identitynow-demo.com",
  };
}

export function asanaDeskPublic(config: AsanaDeskConfig): AsanaDeskPublic {
  return {
    asanaTokenSet: Boolean(config.asanaToken),
    projectName: config.projectName,
    triggerStatus: config.triggerStatus,
    workingStatus: config.workingStatus,
    doneStatus: config.doneStatus,
    declinedStatus: config.declinedStatus,
    accountField: config.accountField,
    codeField: config.codeField,
    tenantLinkField: config.tenantLinkField,
    tenantLinkTemplate: config.tenantLinkTemplate,
  };
}

/** The tenant link uses the tenant bound to Test Drive. */
export function tenantLink(config: AsanaDeskConfig): string {
  const tenant = loadSafPocConfig().tenant;
  if (!tenant) {
    throw new Error("Assign a saved tenant to SAF TestDrive Accounts on the Tenants page first.");
  }
  return config.tenantLinkTemplate.replaceAll("{tenant}", tenant);
}

const DESK_KEY = "READONLY_ACCOUNT#asana-desk";

// Amplify SSR runs on Lambda, which sets AWS_EXECUTION_ENV. A developer shell may
// export AWS_REGION, so that variable is not used to detect a deployed server.
function isDeployedRuntime(): boolean {
  return Boolean(process.env.AWS_EXECUTION_ENV?.trim());
}

export type DeskStorage = {
  storage: "dynamodb" | "local";
  storedAt: string;
};

export function deskStorage(): DeskStorage {
  if (resolveDeskStore(deskPath())) {
    return { storage: "dynamodb", storedAt: process.env.SAF_POC_TABLE_NAME?.trim() ?? "" };
  }
  return { storage: "local", storedAt: "" };
}

// A read error from the shared table is thrown, not hidden. A blank desk on a
// deployed server would look like a missing setup and send tasks to Declined.
export async function loadAsanaDesk(
  filePath = deskPath(),
  store?: SafPocStore | null,
): Promise<AsanaDeskConfig> {
  const shared = resolveDeskStore(filePath, store);
  if (shared) {
    const stored = await shared.get<Partial<AsanaDeskConfig>>(DESK_KEY);
    if (stored) {
      return normalizeDesk({ ...defaultAsanaDesk(), ...stored });
    }
  }
  return readDeskFile(filePath);
}

function readDeskFile(filePath: string): AsanaDeskConfig {
  const defaults = defaultAsanaDesk();
  if (!fs.existsSync(filePath)) {
    return defaults;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<AsanaDeskConfig>;
    return normalizeDesk({ ...defaults, ...parsed });
  } catch {
    return defaults;
  }
}

export function missingDeskFields(config: AsanaDeskConfig): string[] {
  const checks: Array<[string, string]> = [
    ["Asana access token", config.asanaToken],
    ["Tenant link field", config.tenantLinkField],
  ];
  return checks.filter(([, value]) => !value.trim()).map(([label]) => label);
}

export async function saveAsanaDesk(
  input: Partial<AsanaDeskConfig>,
  filePath = deskPath(),
  store?: SafPocStore | null,
): Promise<AsanaDeskConfig> {
  const shared = resolveDeskStore(filePath, store);
  // Copy any tenant still stored on the desk into saved profiles before this save drops it.
  await ensureLegacyTenantsMigrated(shared ?? undefined);
  const current = await loadAsanaDesk(filePath, store);
  const next = normalizeDesk({
    ...current,
    ...input,
    asanaToken: input.asanaToken?.trim() || current.asanaToken,
  });
  const missing = missingDeskFields(next);
  if (missing.length > 0) {
    throw new Error(`Enter ${missing.join(", ")} before connecting.`);
  }
  if (!shared && isDeployedRuntime()) {
    throw new Error(
      "Set SAF_POC_TABLE_NAME in Amplify and redeploy so the back desk is kept. A file on this server is erased on every deploy.",
    );
  }
  if (shared) {
    await shared.put(DESK_KEY, next);
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
  } catch (error) {
    if (!shared) {
      throw error;
    }
  }
  return next;
}

function resolveDeskStore(filePath: string, store?: SafPocStore | null): SafPocStore | null {
  if (store === null) {
    return null;
  }
  if (store) {
    return store;
  }
  if (filePath !== deskPath() || !process.env.SAF_POC_TABLE_NAME?.trim()) {
    return null;
  }
  return getSafPocStore();
}

export function asanaAccessToken(override?: string, config?: AsanaDeskConfig): string {
  return override?.trim() || config?.asanaToken || process.env.ASANA_ACCESS_TOKEN?.trim() || "";
}

/** SailPoint client for the tenant bound to Test Drive. */
export function sailPointClientForDesk() {
  return readonlyAccountClient();
}

function normalizeDesk(config: AsanaDeskConfig): AsanaDeskConfig {
  const defaults = defaultAsanaDesk();
  const text = (value: string | undefined, fallback: string) => {
    const trimmed = value?.trim() ?? "";
    return trimmed || fallback;
  };
  return {
    asanaToken: config.asanaToken?.trim() ?? "",
    projectName: text(config.projectName, defaults.projectName),
    triggerStatus: text(config.triggerStatus, defaults.triggerStatus),
    workingStatus: text(config.workingStatus, defaults.workingStatus),
    doneStatus:
      text(config.doneStatus, defaults.doneStatus).toLowerCase() === "approved"
        ? defaults.doneStatus
        : text(config.doneStatus, defaults.doneStatus),
    declinedStatus: text(config.declinedStatus, defaults.declinedStatus),
    accountField: text(config.accountField, defaults.accountField),
    codeField: text(config.codeField, defaults.codeField),
    tenantLinkField: config.tenantLinkField?.trim() ?? "",
    tenantLinkTemplate: text(config.tenantLinkTemplate, defaults.tenantLinkTemplate),
  };
}

function deskPath(): string {
  return path.join(resolveAgentForgeDataDir(), "readonly-account-asana-desk.json");
}
