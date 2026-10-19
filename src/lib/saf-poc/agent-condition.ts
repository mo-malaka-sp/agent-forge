import { randomUUID, timingSafeEqual } from "node:crypto";

import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { getSafPocStore } from "@/lib/saf-poc/storage";
import { publishRiskLevelChange } from "@/lib/saf-poc/transmitter";
import {
  createSailPointClient,
  type WorkflowSetup,
} from "@/lib/saf-poc/sailpoint";
import {
  listTenantAgents,
  readAgentRiskSnapshot,
  resolveAgentOwnerEmail,
} from "@/lib/saf-poc/tenant-agents";

const RUN_PREFIX = "AGENT_CONDITION#";
const WORKFLOW_KEY = "WORKFLOW#setup";
const EXPERIMENTAL = { "X-SailPoint-Experimental": "true" };
const MAX_WAIT_MS = 5 * 60_000;

export type AgentConditionStatus =
  | "waiting"
  | "restoring"
  | "completed"
  | "no_band_change"
  | "failed"
  | "restore_failed";

export type AgentConditionRun = {
  id: string;
  agentId: string;
  agentName: string;
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  ownerPath: string;
  ownerValue: unknown;
  baselineSeverity: string;
  observedSeverity: string;
  baselineFindings: string[];
  observedFindings: string[];
  status: AgentConditionStatus;
  startedAt: string;
  deadlineAt: string;
  updatedAt: string;
  publicUrl: string;
  caepEventId: string;
  detail: string;
  ownerRestored: boolean;
};

type OwnerPatch = { path: string; value: unknown };

export function ownerPatchFromRecord(value: unknown): OwnerPatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const owners = record.owners;
  if (owners && typeof owners === "object" && !Array.isArray(owners)) {
    const primary = (owners as Record<string, unknown>).primaryIdentity;
    if (primary && typeof primary === "object") {
      return { path: "/owners/primaryIdentity", value: primary };
    }
  }
  if (record.primaryIdentity && typeof record.primaryIdentity === "object") {
    return { path: "/primaryIdentity", value: record.primaryIdentity };
  }
  return null;
}

export function caepBandChange(
  baseline: string,
  observed: string,
  supportedLevels: string[],
): "send" | "unchanged" | "unsupported" {
  if (
    !observed ||
    observed === "Unavailable" ||
    observed.toLowerCase() === baseline.toLowerCase()
  ) {
    return "unchanged";
  }
  return supportedLevels.length > 0 &&
    !supportedLevels.includes(observed.toUpperCase())
    ? "unsupported"
    : "send";
}

export function ownerRemovalPatch(run: Pick<AgentConditionRun, "ownerPath" | "ownerId">) {
  return [
    { op: "test", path: `${run.ownerPath}/id`, value: run.ownerId },
    { op: "remove", path: run.ownerPath },
  ];
}

export function ownerRestorePatch(run: Pick<AgentConditionRun, "ownerPath" | "ownerValue">) {
  return [{ op: "add", path: run.ownerPath, value: run.ownerValue }];
}

export async function startAgentConditionRun(input: {
  agentId: string;
  publicUrl: string;
  confirmed: boolean;
}): Promise<AgentConditionRun> {
  if (!input.confirmed) {
    throw new Error("Confirm the temporary owner change before starting.");
  }
  const store = getSafPocStore();
  const existing = (await store.list<AgentConditionRun>(RUN_PREFIX)).find((item) =>
    ["waiting", "restoring", "restore_failed"].includes(item.value.status),
  );
  if (existing) {
    throw new Error("Restore or finish the active real-condition run first.");
  }
  const config = loadSafPocConfig();
  const agents = await listTenantAgents(config);
  const agent = agents.find((candidate) => candidate.id === input.agentId);
  if (!agent) throw new Error("The selected agent was not found.");
  const ownerEmail = await resolveAgentOwnerEmail(agent, config);
  if (!agent.ownerId || !ownerEmail) {
    throw new Error("Choose a dedicated test agent with a human owner and owner email.");
  }

  const client = createSailPointClient(config);
  const record = await client.request(
    "GET",
    `/v2026/machine-identities/${encodeURIComponent(agent.id)}`,
    undefined,
    "application/json",
    EXPERIMENTAL,
  );
  const ownerPatch = ownerPatchFromRecord(record);
  if (!ownerPatch) {
    throw new Error("The live machine identity owner shape is not safe to patch.");
  }
  const snapshot = await readAgentRiskSnapshot(agent.id, config);
  const now = new Date();
  const run: AgentConditionRun = {
    id: randomUUID(),
    agentId: agent.id,
    agentName: agent.name,
    ownerId: agent.ownerId,
    ownerName: agent.ownerName,
    ownerEmail,
    ownerPath: ownerPatch.path,
    ownerValue: ownerPatch.value,
    baselineSeverity: snapshot.calculatedSeverity,
    observedSeverity: snapshot.calculatedSeverity,
    baselineFindings: snapshot.findings.map((finding) => finding.title),
    observedFindings: snapshot.findings.map((finding) => finding.title),
    status: "waiting",
    startedAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + MAX_WAIT_MS).toISOString(),
    updatedAt: now.toISOString(),
    publicUrl: input.publicUrl,
    caepEventId: "",
    detail: "Owner removed. Waiting for the Risk Engine.",
    ownerRestored: false,
  };
  await store.put(`${RUN_PREFIX}${run.id}`, run);
  try {
    await patchOwner(client, run.agentId, ownerRemovalPatch(run));
  } catch (error) {
    run.detail = error instanceof Error ? error.message : "Owner removal failed.";
    run.status = "restoring";
    return restoreOwner(run, "failed");
  }
  return run;
}

export async function getAgentConditionRun(id?: string): Promise<AgentConditionRun | null> {
  const store = getSafPocStore();
  if (id) return store.get<AgentConditionRun>(`${RUN_PREFIX}${id}`);
  const runs = await store.list<AgentConditionRun>(RUN_PREFIX);
  return (
    runs
      .map((document) => document.value)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ?? null
  );
}

export async function tickAgentConditionRuns(): Promise<AgentConditionRun[]> {
  const documents = await getSafPocStore().list<AgentConditionRun>(RUN_PREFIX);
  const results: AgentConditionRun[] = [];
  for (const { value } of documents) {
    if (["waiting", "restoring", "restore_failed"].includes(value.status)) {
      results.push(await advanceRun(value));
    }
  }
  return results;
}

export async function restoreAgentConditionRun(id: string): Promise<AgentConditionRun> {
  const run = await getAgentConditionRun(id);
  if (!run) throw new Error("Real-condition run not found.");
  run.status = "restoring";
  return restoreOwner(run);
}

async function advanceRun(run: AgentConditionRun): Promise<AgentConditionRun> {
  if (run.status !== "waiting") return restoreOwner(run);
  try {
    const snapshot = await readAgentRiskSnapshot(run.agentId);
    run.observedSeverity = snapshot.calculatedSeverity;
    run.observedFindings = snapshot.findings.map((finding) => finding.title);
    run.updatedAt = new Date().toISOString();
    const workflow = await getSafPocStore().get<WorkflowSetup>(WORKFLOW_KEY);
    const supported = workflow?.trigger.supportedLevels ?? [];
    const bandChange = caepBandChange(
      run.baselineSeverity,
      run.observedSeverity,
      supported,
    );
    if (bandChange !== "unchanged") {
      if (bandChange === "unsupported") {
        run.detail = `Risk became ${run.observedSeverity}, but this workflow trigger does not accept that level.`;
      } else {
        const result = await publishRiskLevelChange({
          publicUrl: run.publicUrl,
          email: run.ownerEmail,
          agentName: run.agentName,
          previousLevel: run.baselineSeverity,
          currentLevel: run.observedSeverity,
        });
        run.caepEventId = result.deliveries[0]?.jti ?? "";
        run.detail = `Risk changed from ${run.baselineSeverity} to ${run.observedSeverity}.`;
      }
      run.status = "restoring";
      return restoreOwner(run);
    }
    if (Date.now() >= Date.parse(run.deadlineAt)) {
      run.status = "restoring";
      run.detail = `Owner signal changed; severity stayed ${run.baselineSeverity}. No CAEP event was sent.`;
      return restoreOwner(run, "no_band_change");
    }
    await saveRun(run);
    return run;
  } catch (error) {
    run.status = "restoring";
    run.detail = error instanceof Error ? error.message : "Condition check failed.";
    return restoreOwner(run, "failed");
  }
}

async function restoreOwner(
  run: AgentConditionRun,
  finalStatus: AgentConditionStatus = "completed",
): Promise<AgentConditionRun> {
  try {
    const client = createSailPointClient(loadSafPocConfig());
    let record = await client.request(
      "GET",
      `/v2026/machine-identities/${encodeURIComponent(run.agentId)}`,
      undefined,
      "application/json",
      EXPERIMENTAL,
    );
    let restored = ownerPatchFromRecord(record);
    if (!restored || ownerId(restored.value) !== run.ownerId) {
      await patchOwner(client, run.agentId, ownerRestorePatch(run));
      record = await client.request(
        "GET",
        `/v2026/machine-identities/${encodeURIComponent(run.agentId)}`,
        undefined,
        "application/json",
        EXPERIMENTAL,
      );
      restored = ownerPatchFromRecord(record);
    }
    if (!restored || ownerId(restored.value) !== run.ownerId) {
      throw new Error("Owner restoration could not be verified.");
    }
    run.ownerRestored = true;
    run.status = finalStatus;
    run.updatedAt = new Date().toISOString();
    await saveRun(run);
    return run;
  } catch (error) {
    run.status = "restore_failed";
    run.ownerRestored = false;
    run.updatedAt = new Date().toISOString();
    run.detail = `Owner restoration needs retry: ${
      error instanceof Error ? error.message : "unknown error"
    }`;
    await saveRun(run);
    return run;
  }
}

async function patchOwner(
  client: ReturnType<typeof createSailPointClient>,
  agentId: string,
  patch: unknown[],
): Promise<void> {
  await client.request(
    "PATCH",
    `/v2026/machine-identities/${encodeURIComponent(agentId)}`,
    patch,
    "application/json-patch+json",
    EXPERIMENTAL,
  );
}

function ownerId(value: unknown): string {
  return value && typeof value === "object" && !Array.isArray(value)
    ? String((value as Record<string, unknown>).id ?? "")
    : "";
}

async function saveRun(run: AgentConditionRun): Promise<void> {
  await getSafPocStore().put(`${RUN_PREFIX}${run.id}`, run);
}

export function workerAuthorized(value: string | null): boolean {
  const expected = loadSafPocConfig().workerToken;
  if (!expected) return false;
  const provided = value?.trim() ?? "";
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}
