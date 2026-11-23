import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveAgentForgeDataDir } from "@/lib/db/store";
import type { DeploymentProvider } from "@/lib/providers/profiles";
import { formatIscTenantUrl, iscHostProblem } from "@/lib/isc/tenant-url";
import {
  profileSecretName,
  profileSecretVault,
  type ProfileSecretVault,
} from "@/lib/isc/profile-secrets";
import type { IscRuntimePayload } from "@/lib/isc/runtime-config";
import { getStoredIscCredentials, readFileSourceIds } from "@/lib/isc/settings-store";
import {
  TENANT_FEATURES,
  type IscBindings,
  type IscProfilePublic,
  type TenantFeature,
  type TenantSources,
} from "@/lib/isc/profile-types";
import { getSafPocStore, type SafPocStore } from "@/lib/saf-poc/storage";

export {
  TENANT_FEATURES,
  TENANT_FEATURE_LABELS,
  type IscBindings,
  type IscProfilePublic,
  type TenantFeature,
  type TenantSources,
} from "@/lib/isc/profile-types";

export type IscProfile = {
  id: string;
  name: string;
  tenant: string;
  domain: string;
  apiVersion: string;
  clientId: string;
  clientSecret: string;
  sources: TenantSources;
  passwordClientId: string;
  passwordClientSecret: string;
  ownerId: string;
  ownerName: string;
  triggerName: string;
  notifyEmail: string;
  lastTest: { at: string; ok: boolean; summary: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type IscProfileInput = {
  name: string;
  tenant: string;
  domain?: string;
  apiVersion?: string;
  clientId: string;
  clientSecret?: string;
  sources?: TenantSources;
  passwordClientId?: string;
  passwordClientSecret?: string;
  ownerId?: string;
  ownerName?: string;
  triggerName?: string;
  notifyEmail?: string;
};

/**
 * What is written to the store. Secrets are not in this record when a vault is configured. The
 * record holds the Secrets Manager name instead. Plaintext fields are only used in local
 * development, which has no vault.
 */
export type StoredIscProfile = Omit<IscProfile, "clientSecret" | "passwordClientSecret"> & {
  clientSecret?: string;
  passwordClientSecret?: string;
  clientSecretRef?: string;
  passwordClientSecretRef?: string;
};

const PROFILE_PREFIX = "ISC_PROFILE#";
const BINDINGS_KEY = "ISC_BINDINGS";
const MIGRATED_KEY = "ISC_TENANTS_MIGRATED";
// Same key the Test Drive desk uses. Read here only to migrate its tenant.
const LEGACY_DESK_KEY = "READONLY_ACCOUNT#asana-desk";

const DEFAULT_TRIGGER = "CAEP Risk Level Change Events";

export function isDeployedRuntime(): boolean {
  return Boolean(process.env.AWS_EXECUTION_ENV?.trim());
}

/**
 * Saved tenants must survive a redeploy. On Amplify the local-file fallback lives in
 * /tmp and is erased, so writes are refused unless SAF_POC_TABLE_NAME is set.
 */
export function durableStorageProblem(store: SafPocStore | null = null): string | null {
  if (store) {
    return null;
  }
  if (!isDeployedRuntime()) {
    return null;
  }
  return process.env.SAF_POC_TABLE_NAME?.trim()
    ? null
    : "Set SAF_POC_TABLE_NAME in Amplify and redeploy. Saved tenants are erased on every deploy without it.";
}

function resolveStore(store?: SafPocStore): SafPocStore {
  return store ?? getSafPocStore();
}

/** Every write goes through here so a deployed instance without a table cannot lose tenants. */
function writableStore(store?: SafPocStore): SafPocStore {
  if (!store) {
    const problem = durableStorageProblem(null);
    if (problem) {
      throw new Error(problem);
    }
  }
  return resolveStore(store);
}

/** Drop empty source slots so only real IDs are stored. */
function presentSources(
  sources: Partial<Record<DeploymentProvider, string | null>> | undefined,
): TenantSources {
  const result: TenantSources = {};
  for (const [provider, value] of Object.entries(sources ?? {})) {
    if (value?.trim()) {
      result[provider as keyof TenantSources] = value.trim();
    }
  }
  return result;
}

export function toPublicProfile(profile: IscProfile | StoredIscProfile): IscProfilePublic {
  const { clientSecret, passwordClientSecret, clientSecretRef, passwordClientSecretRef, ...rest } =
    profile as StoredIscProfile;
  return {
    ...rest,
    clientSecretSet: Boolean(clientSecret || clientSecretRef),
    passwordClientSecretSet: Boolean(passwordClientSecret || passwordClientSecretRef),
    tenantUrl: formatIscTenantUrl(profile.tenant, profile.domain),
  };
}

async function readSecret(
  ref: string | undefined,
  plain: string | undefined,
  vault: ProfileSecretVault | null,
  label: string,
): Promise<string> {
  if (!ref) return plain ?? "";
  if (!vault) {
    throw new Error(
      `The ${label} for a saved tenant is in Secrets Manager. Set SAF_POC_TABLE_NAME, or re-enter the secret.`,
    );
  }
  // A missing secret reads as blank, so the tenant shows "not set" and can be edited.
  return (await vault.get(ref)) ?? "";
}

async function hydrate(stored: StoredIscProfile, vault: ProfileSecretVault | null): Promise<IscProfile> {
  const { clientSecret, passwordClientSecret, clientSecretRef, passwordClientSecretRef, ...rest } =
    stored;
  return {
    ...rest,
    clientSecret: await readSecret(clientSecretRef, clientSecret, vault, "client secret"),
    passwordClientSecret: await readSecret(
      passwordClientSecretRef,
      passwordClientSecret,
      vault,
      "password client secret",
    ),
  };
}

async function getStoredProfile(id: string, store?: SafPocStore): Promise<StoredIscProfile | null> {
  return resolveStore(store).get<StoredIscProfile>(`${PROFILE_PREFIX}${id}`);
}

export async function listProfiles(store?: SafPocStore): Promise<IscProfile[]> {
  const vault = profileSecretVault();
  const entries = await resolveStore(store).list<StoredIscProfile>(PROFILE_PREFIX);
  const profiles = await Promise.all(entries.map((entry) => hydrate(entry.value, vault)));
  return profiles.sort((left, right) => left.name.localeCompare(right.name));
}

export async function getProfile(id: string, store?: SafPocStore): Promise<IscProfile | null> {
  const stored = await getStoredProfile(id, store);
  return stored ? hydrate(stored, profileSecretVault()) : null;
}

export async function getBindings(store?: SafPocStore): Promise<IscBindings> {
  return (await resolveStore(store).get<IscBindings>(BINDINGS_KEY)) ?? {};
}

/** The profile a feature resolves to: its binding, else the default, else none. */
export async function profileForFeature(
  feature: TenantFeature,
  store?: SafPocStore,
): Promise<IscProfile | null> {
  const bindings = await getBindings(store);
  const id = bindings[feature] || bindings.default || null;
  if (!id) {
    return null;
  }
  return getProfile(id, store);
}

function cleanText(value: string | undefined, fallback = ""): string {
  return value?.trim() || fallback;
}

export function validateProfileInput(input: IscProfileInput, existing?: IscProfile | null): string[] {
  const problems: string[] = [];
  if (!cleanText(input.name)) problems.push("Name is required.");
  if (!cleanText(input.tenant)) problems.push("SailPoint tenant is required.");
  if (!cleanText(input.clientId)) problems.push("Client ID is required.");
  if (!cleanText(input.clientSecret) && !existing?.clientSecret) {
    problems.push("Client secret is required.");
  }
  const hostProblem = iscHostProblem(
    cleanText(input.tenant),
    cleanText(input.domain, existing?.domain ?? "identitynow.com"),
  );
  if (hostProblem) problems.push(hostProblem);
  return problems;
}

type SealedSecret = { secret?: string; ref?: string };

/**
 * Decides what a secret looks like in the record. With a vault, a new value goes to Secrets
 * Manager and the record keeps the name. An unchanged value keeps the existing reference, so
 * edits that leave the secret alone never write to the vault. A secret that is still plaintext
 * from before the vault moves into it on the next save.
 */
async function sealSecret(
  vault: ProfileSecretVault | null,
  name: string,
  value: string,
  freshlyEntered: boolean,
  previousRef: string | undefined,
): Promise<SealedSecret> {
  if (!vault) return value ? { secret: value } : {};
  if (value && (freshlyEntered || !previousRef)) {
    await vault.put(name, value);
    return { ref: name };
  }
  return previousRef ? { ref: previousRef } : {};
}

function sealedKeys(
  secretKey: "clientSecret" | "passwordClientSecret",
  refKey: "clientSecretRef" | "passwordClientSecretRef",
  sealed: SealedSecret,
): Partial<StoredIscProfile> {
  // Only keys with a value are written. DynamoDB rejects undefined attributes.
  const keys: Partial<StoredIscProfile> = {};
  if (sealed.secret) keys[secretKey] = sealed.secret;
  if (sealed.ref) keys[refKey] = sealed.ref;
  return keys;
}

export async function saveProfile(
  input: IscProfileInput,
  options: { id?: string; store?: SafPocStore } = {},
): Promise<IscProfilePublic> {
  const store = writableStore(options.store);
  const existing = options.id ? await getProfile(options.id, store) : null;
  const previousStored = options.id ? await getStoredProfile(options.id, store) : null;
  const vault = profileSecretVault();
  if (options.id && !existing) {
    throw new Error("Tenant profile not found.");
  }
  const problems = validateProfileInput(input, existing);
  if (problems.length > 0) {
    throw new Error(problems.join(" "));
  }
  const now = new Date().toISOString();
  const profile: IscProfile = {
    id: existing?.id ?? randomUUID(),
    name: cleanText(input.name),
    tenant: cleanText(input.tenant),
    domain: cleanText(input.domain, existing?.domain ?? "identitynow.com"),
    apiVersion: cleanText(input.apiVersion, existing?.apiVersion ?? "v2026"),
    clientId: cleanText(input.clientId),
    clientSecret: cleanText(input.clientSecret, existing?.clientSecret ?? ""),
    // The form always sends the full sources object, so a blank slot clears the saved ID.
    sources: input.sources !== undefined ? presentSources(input.sources) : (existing?.sources ?? {}),
    passwordClientId: cleanText(input.passwordClientId, existing?.passwordClientId ?? ""),
    passwordClientSecret: cleanText(
      input.passwordClientSecret,
      existing?.passwordClientSecret ?? "",
    ),
    ownerId: cleanText(input.ownerId, existing?.ownerId ?? ""),
    ownerName: cleanText(input.ownerName, existing?.ownerName ?? ""),
    triggerName: cleanText(input.triggerName, existing?.triggerName ?? DEFAULT_TRIGGER),
    notifyEmail: cleanText(input.notifyEmail, existing?.notifyEmail ?? ""),
    lastTest: existing?.lastTest ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const { clientSecret, passwordClientSecret, ...plain } = profile;
  const client = await sealSecret(
    vault,
    profileSecretName(profile.id, "client"),
    clientSecret,
    Boolean(cleanText(input.clientSecret)),
    previousStored?.clientSecretRef,
  );
  const password = await sealSecret(
    vault,
    profileSecretName(profile.id, "password-client"),
    passwordClientSecret,
    Boolean(cleanText(input.passwordClientSecret)),
    previousStored?.passwordClientSecretRef,
  );
  const stored: StoredIscProfile = {
    ...plain,
    ...sealedKeys("clientSecret", "clientSecretRef", client),
    ...sealedKeys("passwordClientSecret", "passwordClientSecretRef", password),
  };
  await store.put(`${PROFILE_PREFIX}${profile.id}`, stored);
  if (!existing) {
    // The first saved tenant becomes the default, so features with no binding use it.
    const bindings = await getBindings(store);
    if (!bindings.default) {
      await store.put(BINDINGS_KEY, { ...bindings, default: profile.id });
    }
  }
  return toPublicProfile(profile);
}

/**
 * Sets source IDs on one profile. A key left out of `patch` is kept. A key with a blank value
 * clears that source ID. Callers clear the feature tenant cache afterwards.
 */
export async function updateProfileSources(
  id: string,
  patch: Partial<Record<DeploymentProvider, string | null>>,
  store?: SafPocStore,
): Promise<IscProfilePublic> {
  const writer = writableStore(store);
  const profile = await getStoredProfile(id, writer);
  if (!profile) {
    throw new Error("Tenant profile not found.");
  }
  const sources: TenantSources = { ...profile.sources };
  for (const [provider, value] of Object.entries(patch)) {
    const key = provider as keyof TenantSources;
    if (value === undefined) continue;
    if (value?.trim()) sources[key] = value.trim();
    else delete sources[key];
  }
  const next: StoredIscProfile = { ...profile, sources, updatedAt: new Date().toISOString() };
  await writer.put(`${PROFILE_PREFIX}${id}`, next);
  return toPublicProfile(next);
}

export async function recordProfileTest(
  id: string,
  result: { ok: boolean; summary: string },
  store?: SafPocStore,
): Promise<void> {
  const writer = writableStore(store);
  const profile = await getStoredProfile(id, writer);
  if (!profile) {
    return;
  }
  await writer.put(`${PROFILE_PREFIX}${id}`, {
    ...profile,
    lastTest: { at: new Date().toISOString(), ...result },
  });
}

export async function deleteProfile(id: string, store?: SafPocStore): Promise<void> {
  const resolved = writableStore(store);
  const bindings = await getBindings(resolved);
  const bound = TENANT_FEATURES.filter((feature) => bindings[feature] === id);
  if (bound.length > 0) {
    const names = bound.map((feature) => FEATURE_NAMES[feature]).join(", ");
    throw new Error(`This tenant is used by ${names}. Assign another tenant first.`);
  }
  // Remove the client secrets from Secrets Manager along with the record.
  const stored = await getStoredProfile(id, resolved);
  const vault = profileSecretVault();
  for (const name of [stored?.clientSecretRef, stored?.passwordClientSecretRef]) {
    if (name && vault) await vault.delete(name);
  }
  await resolved.delete(`${PROFILE_PREFIX}${id}`);
}

const FEATURE_NAMES: Record<TenantFeature, string> = {
  default: "Default",
  "test-drive": "SAF TestDrive Accounts",
  caep: "CAEP event bus",
  datadog: "Datadog security signals",
  endpoint: "Endpoint agent risk",
  ask: "Ask this tenant",
  govern: "Govern and environments",
};

export async function setBinding(
  feature: TenantFeature,
  profileId: string | null,
  store?: SafPocStore,
): Promise<IscBindings> {
  if (!TENANT_FEATURES.includes(feature)) {
    throw new Error(`Unknown feature "${feature}".`);
  }
  const resolved = writableStore(store);
  if (profileId && !(await getStoredProfile(profileId, resolved))) {
    throw new Error("Tenant profile not found.");
  }
  const bindings = await getBindings(resolved);
  const next: IscBindings = { ...bindings, [feature]: profileId };
  await resolved.put(BINDINGS_KEY, next);
  return next;
}

/** Runtime payload for a profile. Used by the feature wrapper and by config readers. */
export function profileRuntime(profile: IscProfile): IscRuntimePayload {
  // The client secret is sent to this host, so refuse any domain that is not on the allowlist.
  const hostProblem = iscHostProblem(profile.tenant, profile.domain);
  if (hostProblem) {
    throw new Error(`Tenant "${profile.name}": ${hostProblem}`);
  }
  return {
    tenant: profile.tenant,
    client_id: profile.clientId,
    client_secret: profile.clientSecret,
    api_version: profile.apiVersion,
    domain: profile.domain,
    sources: profile.sources,
    profile_id: profile.id,
    profile_name: profile.name,
    saf: {
      passwordClientId: profile.passwordClientId,
      passwordClientSecret: profile.passwordClientSecret,
      ownerId: profile.ownerId,
      ownerName: profile.ownerName,
      triggerName: profile.triggerName,
      notifyEmail: profile.notifyEmail,
    },
  };
}

type LegacyTenant = {
  label: string;
  tenant: string;
  domain: string;
  clientId: string;
  clientSecret: string;
  sources: TenantSources;
  saf: IscProfileInput;
};

type LegacyDesk = { tenant?: string; clientId?: string; clientSecret?: string };

function domainFromApiBase(apiBase: string): string {
  const host = apiBase.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const match = host.match(/^[^.]+\.api\.(.+)$/);
  return match?.[1] ?? "";
}

/** Local development keeps the desk in a file. Read it only for the one-time migration. */
function readLegacyDeskFile(): LegacyDesk | null {
  const filePath = path.join(resolveAgentForgeDataDir(), "readonly-account-asana-desk.json");
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as LegacyDesk;
  } catch {
    return null;
  }
}

/** Tenants that exist today in env vars, the Test Drive desk record, or the saved ISC connection. */
async function legacyTenants(store: SafPocStore): Promise<LegacyTenant[]> {
  const found: LegacyTenant[] = [];
  const env = process.env;

  const envTenant = env.SAF_TENANT?.trim() || env.ISC_TENANT?.trim() || "";
  const envClientId = env.SAF_CLIENT_ID?.trim() || env.ISC_CLIENT_ID?.trim() || "";
  const envClientSecret = env.SAF_CLIENT_SECRET?.trim() || env.ISC_CLIENT_SECRET?.trim() || "";
  if (envTenant && envClientId && envClientSecret) {
    const domain =
      domainFromApiBase(env.SAF_API_BASE?.trim() ?? "") ||
      env.ISC_DOMAIN?.trim() ||
      "identitynow.com";
    found.push({
      label: "Environment tenant",
      tenant: envTenant,
      domain,
      clientId: envClientId,
      clientSecret: envClientSecret,
      sources: presentSources(readFileSourceIds()),
      saf: {
        name: "Environment tenant",
        tenant: envTenant,
        domain,
        clientId: envClientId,
        clientSecret: envClientSecret,
        passwordClientId: env.SAF_PASSWORD_CLIENT_ID?.trim() || "",
        passwordClientSecret: env.SAF_PASSWORD_CLIENT_SECRET?.trim() || "",
        ownerId: env.SAF_OWNER_ID?.trim() || "",
        ownerName: env.SAF_OWNER_NAME?.trim() || "",
        triggerName: env.SAF_TRIGGER_NAME?.trim() || DEFAULT_TRIGGER,
        notifyEmail: env.SAF_NOTIFY_EMAIL?.trim() || "",
      },
    });
  }

  const desk =
    (await store.get<LegacyDesk>(LEGACY_DESK_KEY)) ?? readLegacyDeskFile();
  if (desk?.tenant?.trim() && desk.clientId?.trim() && desk.clientSecret?.trim()) {
    found.push({
      label: "Test Drive desk tenant",
      tenant: desk.tenant.trim(),
      domain: "identitynow-demo.com",
      clientId: desk.clientId.trim(),
      clientSecret: desk.clientSecret.trim(),
      sources: {},
      saf: {
        name: "Test Drive desk tenant",
        tenant: desk.tenant.trim(),
        domain: "identitynow-demo.com",
        clientId: desk.clientId.trim(),
        clientSecret: desk.clientSecret.trim(),
      },
    });
  }

  const stored = getStoredIscCredentials();
  if (stored) {
    found.push({
      label: "Saved ISC connection",
      tenant: stored.tenant,
      domain: stored.domain,
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
      sources: presentSources(readFileSourceIds()),
      saf: {
        name: "Saved ISC connection",
        tenant: stored.tenant,
        domain: stored.domain,
        clientId: stored.clientId,
        clientSecret: stored.clientSecret,
      },
    });
  }
  return found;
}

let migrated = false;

/**
 * Copies the tenants that exist today into saved profiles, once. Nothing is deleted, and an
 * identical tenant (same tenant and client ID) is not copied twice.
 */
export async function ensureLegacyTenantsMigrated(store?: SafPocStore): Promise<void> {
  if (migrated) {
    return;
  }
  const resolved = resolveStore(store);
  if (await resolved.get<{ done: boolean }>(MIGRATED_KEY)) {
    migrated = true;
    return;
  }
  const existing = await listProfiles(resolved);
  const bindings = await getBindings(resolved);
  const nextBindings: IscBindings = { ...bindings };
  let envProfileId: string | null = null;
  let deskMigrated = false;

  for (const legacy of await legacyTenants(resolved)) {
    const match = existing.find(
      (profile) => profile.tenant === legacy.tenant && profile.clientId === legacy.clientId,
    );
    const hostProblem = match ? null : iscHostProblem(legacy.tenant, legacy.domain);
    if (hostProblem) {
      // A domain outside the allowlist is not copied. Other errors still stop the migration, so
      // a transient storage failure cannot mark a tenant as done without copying it.
      console.warn(`Not migrating "${legacy.label}": ${hostProblem}`);
      continue;
    }
    const id =
      match?.id ??
      (await saveProfile({ ...legacy.saf, sources: legacy.sources }, { store: resolved })).id;
    if (!match) {
      const created = await getProfile(id, resolved);
      if (created) existing.push(created);
    }
    if (legacy.label === "Environment tenant") envProfileId = id;
    if (legacy.label === "Test Drive desk tenant") {
      deskMigrated = true;
      nextBindings["test-drive"] = nextBindings["test-drive"] ?? id;
    }
  }

  if (!nextBindings.default) {
    nextBindings.default = envProfileId ?? existing[0]?.id ?? null;
  }
  await resolved.put(BINDINGS_KEY, nextBindings);
  // The desk secret now lives in its profile. Once that is copied, remove the plaintext copy
  // from the desk record. Only done with a vault, so local development keeps working.
  const deskRecord = await resolved.get<Record<string, unknown>>(LEGACY_DESK_KEY);
  if (deskMigrated && profileSecretVault() && deskRecord && "clientSecret" in deskRecord) {
    const rest: Record<string, unknown> = { ...deskRecord };
    delete rest.clientSecret;
    await resolved.put(LEGACY_DESK_KEY, rest);
  }
  await resolved.put(MIGRATED_KEY, { done: true });
  migrated = true;
}

/** Test-only: forget the in-memory migration flag. */
export function resetProfilesMigrationForTests(): void {
  migrated = false;
}
