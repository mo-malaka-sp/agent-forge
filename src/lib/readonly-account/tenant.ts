import { constants, publicEncrypt } from "node:crypto";

import { loadSafPocConfig } from "@/lib/saf-poc/config";
import {
  createSailPointClient,
  SailPointApiError,
  type SailPointSetupConfig,
} from "@/lib/saf-poc/sailpoint";

export const ADMINS_SOURCE_NAME = "ISC Admins";
export const IDENTITYNOW_SOURCE_NAME = "IdentityNow";
export const ROLE_NAME = "ReadOnly-Admins";
export const GROUP_VALUE = "ReadOnly-Admins";
export const SAF_ADMIN_ENTITLEMENT = "SAF Admin";
export const TEST_EMAIL_DOMAIN = "testmail.identitysoon.com";
export const CAMPAIGN_LOCATION = "SAF Test Drive";
export const ACTIVE_STATE = "active";

const FIRST_NAMES = [
  "maya", "liam", "nora", "owen", "zara", "ava", "leo", "ruby", "ivy", "kai",
  "mia", "noah", "sara", "theo", "luca", "jade", "omar", "rosa", "ezra", "lena",
  "milo", "nina", "cole", "dana", "evan", "hugo", "iris", "kira", "luis", "nico",
] as const;
const LAST_NAMES = [
  "chen", "patel", "garcia", "kim", "nguyen", "silva", "khan", "lopez", "reyes",
  "shah", "ward", "baker", "costa", "diaz", "ford", "grant", "hayes", "kato",
  "lane", "ortiz", "price", "rivera", "stone", "perez", "vega", "west", "cruz",
  "park", "young", "boyd",
] as const;
const DIGITS = "23456789";
const ATTEMPTS_PER_LENGTH = 10;
const SAFE_ID = /^[A-Za-z0-9-]+$/;

type Client = ReturnType<typeof createSailPointClient>;
type JsonRecord = Record<string, unknown>;

export type StepStatus = "found" | "created" | "updated" | "ok" | "pending" | "failed";
export type SetupStep = { label: string; status: StepStatus; detail: string };

export type SetupResult = {
  ok: boolean;
  steps: SetupStep[];
  error?: string;
};

export type TestUser = {
  id: string;
  name: string;
  givenName: string;
  familyName: string;
  email: string;
  password: string;
};

export type TenantRefs = {
  sourceId: string;
  profileId: string;
  activeStateId: string;
  identityNowSourceId: string;
};

export type CreateResult = {
  user: TestUser;
  attempts: number;
  taskId: string | null;
  refs: TenantRefs;
  emailRedirect: string | null;
};

export type ActivationInput = TenantRefs & {
  userId: string;
  taskId?: string | null;
  password?: string;
  passwordSet?: boolean;
  passwordError?: string | null;
  redirectEmail?: string;
  sendInvite?: boolean;
  inviteEmail?: string;
  inviteSent?: boolean;
  inviteError?: string | null;
  attempt: number;
  processed: boolean;
};

export type ActivationResult = {
  done: boolean;
  phase: "account-pending" | "identity-pending" | "activating" | "complete";
    detail: string;
    identityId: string | null;
    alias: string | null;
  processed: boolean;
  lifecycleState: string | null;
  accountEnabled: boolean | null;
  roleAssigned: boolean;
  passwordSet: boolean;
  passwordError: string | null;
  inviteSent: boolean;
  inviteError: string | null;
};

const EXPERIMENTAL_HEADER = { "X-SailPoint-Experimental": "true" };

export function readonlyAccountClient(config: SailPointSetupConfig = loadSafPocConfig()) {
  const client = createSailPointClient(config);
  return {
    ...client,
    listRecords: (path: string, extraHeaders?: Record<string, string>) =>
      client.listRecords(path, { ...EXPERIMENTAL_HEADER, ...extraHeaders }),
    request: (
      method: string,
      path: string,
      body?: unknown,
      contentType?: string,
      extraHeaders?: Record<string, string>,
    ) =>
      client.request(method, path, body, contentType, {
        ...EXPERIMENTAL_HEADER,
        ...extraHeaders,
      }),
  };
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function filtered(path: string, filter: string): string {
  return `${path}?filters=${encodeURIComponent(filter)}`;
}

async function list(client: Client, path: string): Promise<JsonRecord[]> {
  return (await client.listRecords(path)).map(record);
}

function accountIsUser(account: JsonRecord, userId: string): boolean {
  return (
    text(account.nativeIdentity) === userId || text(record(account.attributes).id) === userId
  );
}

async function assertCreateTask(client: Client, taskId: string | null | undefined) {
  if (!taskId || !SAFE_ID.test(taskId)) {
    return;
  }
  const status = record(
    await client.request("GET", `/task-status/v1/${encodeURIComponent(taskId)}`).catch(() => null),
  );
  const completion = text(status.completionStatus).toUpperCase();
  if (["ERROR", "FAILED", "FAILURE", "TERMINATED"].includes(completion)) {
    throw new Error(`The ISC Admins account task failed (${completion}). ${inputTaskDetail(status)}`);
  }
}

function inputTaskDetail(status: JsonRecord): string {
  const messages = Array.isArray(status.messages) ? status.messages : [];
  const textValue = messages
    .map((entry) => text(record(record(entry).localizedText).text) || text(record(entry).key))
    .find(Boolean);
  return textValue ?? "Check Task Manager for that task id.";
}

function requireSafeId(label: string, value: string): string {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return value;
}

async function findSource(client: Client, name: string): Promise<JsonRecord> {
  const sources = await list(client, filtered("/sources/v1", `name eq ${quoted(name)}`));
  const source = sources.find((candidate) => text(candidate.name) === name);
  if (!source || !text(source.id)) {
    throw new Error(`Source "${name}" was not found in the tenant.`);
  }
  return source;
}

async function findProfile(client: Client, sourceId: string): Promise<JsonRecord> {
  const profiles = await list(client, "/identity-profiles/v1");
  const profile = profiles.find(
    (candidate) => text(record(candidate.authoritativeSource).id) === sourceId,
  );
  if (!profile || !text(profile.id)) {
    throw new Error(
      `No identity profile uses "${ADMINS_SOURCE_NAME}" as its authoritative source.`,
    );
  }
  return profile;
}

async function findActiveState(client: Client, profileId: string): Promise<JsonRecord | null> {
  const states = await list(
    client,
    `/identity-profiles/v1/${encodeURIComponent(profileId)}/lifecycle-states`,
  );
  return states.find((state) => text(state.technicalName) === ACTIVE_STATE) ?? null;
}

async function findSafAdminEntitlement(client: Client): Promise<JsonRecord> {
  const entitlements = await list(
    client,
    filtered("/entitlements/v1", `name eq ${quoted(SAF_ADMIN_ENTITLEMENT)}`),
  );
  const named = entitlements.filter(
    (entitlement) => text(entitlement.name) === SAF_ADMIN_ENTITLEMENT,
  );
  const entitlement =
    named.find(
      (candidate) => text(record(candidate.source).name) === IDENTITYNOW_SOURCE_NAME,
    ) ?? (named.length === 1 ? named[0] : undefined);
  if (!entitlement || !text(entitlement.id)) {
    throw new Error(
      `Entitlement "${SAF_ADMIN_ENTITLEMENT}" was not found on the ${IDENTITYNOW_SOURCE_NAME} source.`,
    );
  }
  return entitlement;
}

async function identityNowSourceId(client: Client): Promise<string> {
  const entitlement = await findSafAdminEntitlement(client);
  const fromList = text(record(entitlement.source).id);
  if (fromList) {
    return fromList;
  }
  const full = record(
    await client.request(
      "GET",
      `/entitlements/v1/${encodeURIComponent(text(entitlement.id))}`,
    ),
  );
  const fromDetail = text(record(full.source).id);
  if (fromDetail) {
    return fromDetail;
  }
  throw new Error(
    `The ${SAF_ADMIN_ENTITLEMENT} entitlement did not include its ${IDENTITYNOW_SOURCE_NAME} source id.`,
  );
}

export function roleMembership(sourceId: string) {
  return {
    type: "STANDARD",
    criteria: {
      operation: "OR",
      children: [
        {
          operation: "CONTAINS",
          key: { type: "ACCOUNT", property: "attribute.groups", sourceId },
          stringValue: GROUP_VALUE,
        },
      ],
    },
  };
}

function hasGroupsCriteria(membership: unknown, sourceId: string): boolean {
  const selector = record(membership);
  if (text(selector.type) !== "STANDARD") {
    return false;
  }
  const matches = (node: unknown): boolean => {
    const criteria = record(node);
    const key = record(criteria.key);
    if (
      text(criteria.operation) === "CONTAINS" &&
      text(key.type) === "ACCOUNT" &&
      text(key.property) === "attribute.groups" &&
      text(key.sourceId) === sourceId &&
      text(criteria.stringValue) === GROUP_VALUE
    ) {
      return true;
    }
    return Array.isArray(criteria.children) && criteria.children.some(matches);
  };
  return matches(selector.criteria);
}

export function rolePatch(role: JsonRecord, entitlementId: string, sourceId: string) {
  const operations: Array<{ op: string; path: string; value: unknown }> = [];
  if (role.enabled !== true) {
    operations.push({ op: "replace", path: "/enabled", value: true });
  }
  const entitlements = Array.isArray(role.entitlements) ? role.entitlements : [];
  if (!entitlements.some((entry) => text(record(entry).id) === entitlementId)) {
    operations.push({
      op: "add",
      path: "/entitlements/-",
      value: { type: "ENTITLEMENT", id: entitlementId },
    });
  }
  if (!hasGroupsCriteria(role.membership, sourceId)) {
    operations.push({ op: "replace", path: "/membership", value: roleMembership(sourceId) });
  }
  return operations;
}

async function patch(client: Client, path: string, operations: unknown[]) {
  return client.request("PATCH", path, operations, "application/json-patch+json");
}

export async function setupTenant(client: Client): Promise<SetupResult> {
  const steps: SetupStep[] = [];
  try {
    const source = await findSource(client, ADMINS_SOURCE_NAME);
    const sourceId = text(source.id);
    steps.push({ label: `${ADMINS_SOURCE_NAME} source`, status: "found", detail: sourceId });

    const profile = await findProfile(client, sourceId);
    const profileId = text(profile.id);
    steps.push({
      label: "Identity profile",
      status: "found",
      detail: text(profile.name) || profileId,
    });

    const active = await findActiveState(client, profileId);
    if (!active) {
      const created = record(
        await client.request(
          "POST",
          `/identity-profiles/v1/${encodeURIComponent(profileId)}/lifecycle-states`,
          { name: "Active", technicalName: ACTIVE_STATE, enabled: true },
        ),
      );
      steps.push({ label: "Active lifecycle state", status: "created", detail: text(created.id) });
    } else if (active.enabled !== true) {
      await patch(
        client,
        `/identity-profiles/v1/${encodeURIComponent(profileId)}/lifecycle-states/${encodeURIComponent(text(active.id))}`,
        [{ op: "replace", path: "/enabled", value: true }],
      );
      steps.push({ label: "Active lifecycle state", status: "updated", detail: "Enabled" });
    } else {
      steps.push({ label: "Active lifecycle state", status: "ok", detail: text(active.id) });
    }

    const entitlement = await findSafAdminEntitlement(client);
    const entitlementId = text(entitlement.id);
    steps.push({
      label: `${SAF_ADMIN_ENTITLEMENT} entitlement`,
      status: "found",
      detail: `${text(record(entitlement.source).name) || IDENTITYNOW_SOURCE_NAME} · ${entitlementId}`,
    });

    const roles = await list(client, filtered("/roles/v1", `name eq ${quoted(ROLE_NAME)}`));
    const existing = roles.find((role) => text(role.name) === ROLE_NAME);
    if (!existing) {
      const owner = record(source.owner);
      if (!text(owner.id)) {
        throw new Error(`"${ADMINS_SOURCE_NAME}" has no owner to own the role.`);
      }
      const created = record(
        await client.request("POST", "/roles/v1", {
          name: ROLE_NAME,
          description: `Grants ${SAF_ADMIN_ENTITLEMENT} to ${ADMINS_SOURCE_NAME} accounts whose groups contain ${GROUP_VALUE}.`,
          owner: { type: "IDENTITY", id: text(owner.id), name: text(owner.name) },
          enabled: true,
          requestable: false,
          accessProfiles: [],
          entitlements: [{ type: "ENTITLEMENT", id: entitlementId }],
          membership: roleMembership(sourceId),
        }),
      );
      steps.push({ label: `${ROLE_NAME} role`, status: "created", detail: text(created.id) });
    } else {
      const roleId = text(existing.id);
      const role = record(
        await client.request("GET", `/roles/v1/${encodeURIComponent(roleId)}`),
      );
      const operations = rolePatch(role, entitlementId, sourceId);
      if (operations.length > 0) {
        await patch(client, `/roles/v1/${encodeURIComponent(roleId)}`, operations);
        steps.push({
          label: `${ROLE_NAME} role`,
          status: "updated",
          detail: operations.map((operation) => operation.path).join(", "),
        });
      } else {
        steps.push({ label: `${ROLE_NAME} role`, status: "ok", detail: roleId });
      }
    }
    return { ok: true, steps };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tenant setup failed.";
    steps.push({ label: "Setup stopped", status: "failed", detail: message });
    return { ok: false, steps, error: message };
  }
}

function pick<T>(values: readonly T[], random: () => number): T {
  return values[Math.floor(random() * values.length) % values.length];
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function generateTestUser(digits: number, random: () => number = Math.random): TestUser {
  const first = pick(FIRST_NAMES, random);
  const last = pick(LAST_NAMES, random);
  let suffix = "";
  for (let index = 0; index < digits; index += 1) {
    suffix += pick(DIGITS.split(""), random);
  }
  const id = `${first}.${last}${suffix}`;
  return {
    id,
    name: `${capitalize(first)} ${capitalize(last)}`,
    givenName: capitalize(first),
    familyName: capitalize(last),
    email: `${id}@${TEST_EMAIL_DOMAIN}`,
    password: `TestDrive${suffix}!`,
  };
}

export function encryptPassword(publicKey: string, password: string): string {
  const key = publicKey.includes("BEGIN PUBLIC KEY")
    ? publicKey
    : `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(password, "utf8"),
  ).toString("base64");
}

async function setIdentityPassword(client: Client, userName: string, password: string) {
  const info = record(
    await client.request("POST", "/query-password-info/v1", {
      userName,
      sourceName: IDENTITYNOW_SOURCE_NAME,
    }),
  );
  const publicKey = text(info.publicKey);
  const publicKeyId = text(info.publicKeyId);
  const identityId = text(info.identityId);
  if (!publicKey || !publicKeyId || !identityId) {
    throw new Error("SailPoint did not return the password encryption key.");
  }
  await client.request("POST", "/set-password/v1", {
    identityId,
    publicKeyId,
    sourceId: text(info.sourceId) || undefined,
    encryptedPassword: encryptPassword(publicKey, password),
  });
}

export const NAME_LISTS = { first: FIRST_NAMES, last: LAST_NAMES, digits: DIGITS };

async function isTaken(client: Client, sourceId: string, user: TestUser): Promise<boolean> {
  const accounts = await list(
    client,
    filtered(
      "/accounts/v1",
      `sourceId eq ${quoted(sourceId)} and nativeIdentity eq ${quoted(user.id)}`,
    ),
  );
  if (accounts.length > 0) {
    return true;
  }
  const identities = await list(
    client,
    filtered(
      "/identities/v1",
      `alias eq ${quoted(user.id)} or email eq ${quoted(user.email)}`,
    ),
  );
  return identities.length > 0;
}

export async function pickUniqueUser(
  client: Client,
  sourceId: string,
  random: () => number = Math.random,
): Promise<{ user: TestUser; attempts: number }> {
  let attempts = 0;
  for (const digits of [0, 2, 3]) {
    for (let index = 0; index < ATTEMPTS_PER_LENGTH; index += 1) {
      attempts += 1;
      const user = generateTestUser(digits, random);
      if (!(await isTaken(client, sourceId, user))) {
        return { user, attempts };
      }
    }
  }
  throw new Error(
    `Could not find an unused test account name after ${attempts} attempts. Try again.`,
  );
}

async function resolveRefs(client: Client): Promise<TenantRefs> {
  const source = await findSource(client, ADMINS_SOURCE_NAME);
  const sourceId = text(source.id);
  const profileId = text((await findProfile(client, sourceId)).id);
  const active = await findActiveState(client, profileId);
  if (!active || active.enabled !== true) {
    throw new Error("The active lifecycle state is not ready. Run Set up tenant first.");
  }
  const roles = await list(client, filtered("/roles/v1", `name eq ${quoted(ROLE_NAME)}`));
  if (!roles.some((role) => text(role.name) === ROLE_NAME && role.enabled === true)) {
    throw new Error(`The ${ROLE_NAME} role is not ready. Run Set up tenant first.`);
  }
  return {
    sourceId,
    profileId,
    activeStateId: text(active.id),
    identityNowSourceId: await identityNowSourceId(client),
  };
}

const EMAIL_TEST_MODE_PATH = "/beta/notification-preferences/email-test-mode";

export function normalizeRedirectEmail(value: string): string {
  const email = value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error("Enter a valid email address for tenant email redirection.");
  }
  return email;
}

export async function setTenantEmailRedirect(client: Client, email: string): Promise<string> {
  const address = normalizeRedirectEmail(email);
  await client.request("PUT", EMAIL_TEST_MODE_PATH, {
    emailTestMode: true,
    emailTestAddress: address,
  });
  return address;
}

export function requestedUser(
  givenName: string,
  familyName: string,
  email: string,
  digits = 0,
  random: () => number = Math.random,
): TestUser {
  let suffix = "";
  for (let index = 0; index < digits; index += 1) {
    suffix += pick(DIGITS.split(""), random);
  }
  const first = givenName.trim().toLowerCase();
  const last = familyName.trim().toLowerCase();
  const id = `${first}.${last}${suffix}`;
  return {
    id,
    name: `${capitalize(first)} ${capitalize(last)}`,
    givenName: capitalize(first),
    familyName: capitalize(last),
    email: email.trim(),
    password: "",
  };
}

export function asanaAccountLocation(taskGid: string): string {
  return `${CAMPAIGN_LOCATION} asana:${taskGid}`;
}

export async function pickUniqueRequestedUser(
  client: Client,
  sourceId: string,
  givenName: string,
  familyName: string,
  email: string,
  random: () => number = Math.random,
): Promise<{ user: TestUser; attempts: number }> {
  const identities = await list(
    client,
    filtered("/identities/v1", `email eq ${quoted(email.trim())}`),
  );
  if (identities.length > 0) {
    throw new Error("This email already has an identity.");
  }
  let attempts = 0;
  for (const digits of [0, 2, 3]) {
    for (let index = 0; index < ATTEMPTS_PER_LENGTH; index += 1) {
      attempts += 1;
      const user = requestedUser(givenName, familyName, email, digits, random);
      const accounts = await list(
        client,
        filtered(
          "/accounts/v1",
          `sourceId eq ${quoted(sourceId)} and nativeIdentity eq ${quoted(user.id)}`,
        ),
      );
      const aliases = await list(
        client,
        filtered("/identities/v1", `alias eq ${quoted(user.id)}`),
      );
      if (accounts.length === 0 && aliases.length === 0) {
        return { user, attempts };
      }
    }
  }
  throw new Error(`Could not find an unused sign-in id after ${attempts} attempts. Try again.`);
}

export async function createRequestedAccount(
  client: Client,
  user: TestUser,
  location: string,
  refs: TenantRefs,
): Promise<CreateResult> {
  const response = record(
    await client.request("POST", "/accounts/v1", {
      attributes: {
        sourceId: refs.sourceId,
        id: user.id,
        name: user.id,
        givenName: user.givenName,
        familyName: user.familyName,
        "e-mail": user.email,
        location,
        groups: GROUP_VALUE,
      },
    }),
  );
  return { user, attempts: 1, taskId: text(response.id) || null, refs, emailRedirect: null };
}

export async function findAccountByLocation(
  client: Client,
  sourceId: string,
  location: string,
): Promise<JsonRecord | null> {
  const accounts = await list(
    client,
    filtered("/accounts/v1", `sourceId eq ${quoted(sourceId)}`),
  );
  return (
    accounts.find((account) => text(record(account.attributes).location) === location) ?? null
  );
}

export async function openRequestedAccount(
  client: Client,
  input: { givenName: string; familyName: string; email: string; location: string },
  random: () => number = Math.random,
): Promise<{ created: boolean; result: CreateResult }> {
  const refs = await resolveRefs(client);
  const existing = await findAccountByLocation(client, refs.sourceId, input.location);
  if (existing) {
    const attributes = record(existing.attributes);
    const id = text(existing.nativeIdentity) || text(attributes.id);
    return {
      created: false,
      result: {
        user: {
          id,
          name: `${capitalize(input.givenName.trim().toLowerCase())} ${capitalize(input.familyName.trim().toLowerCase())}`,
          givenName: text(attributes.givenName) || capitalize(input.givenName),
          familyName: text(attributes.familyName) || capitalize(input.familyName),
          email: text(attributes["e-mail"]) || input.email,
          password: "",
        },
        attempts: 0,
        taskId: null,
        refs,
        emailRedirect: null,
      },
    };
  }
  const { user, attempts } = await pickUniqueRequestedUser(
    client,
    refs.sourceId,
    input.givenName,
    input.familyName,
    input.email,
    random,
  );
  const result = await createRequestedAccount(client, user, input.location, refs);
  return { created: true, result: { ...result, attempts } };
}

export async function createTestAccount(
  client: Client,
  random: () => number = Math.random,
  redirectEmail = "",
): Promise<CreateResult> {
  const emailRedirect = redirectEmail.trim()
    ? await setTenantEmailRedirect(client, redirectEmail)
    : null;
  const refs = await resolveRefs(client);
  const { user, attempts } = await pickUniqueUser(client, refs.sourceId, random);
  const response = record(
    await client.request("POST", "/accounts/v1", {
      attributes: {
        sourceId: refs.sourceId,
        id: user.id,
        name: user.id,
        givenName: user.givenName,
        familyName: user.familyName,
        "e-mail": user.email,
        location: CAMPAIGN_LOCATION,
        groups: GROUP_VALUE,
      },
    }),
  );
  return { user, attempts, taskId: text(response.id) || null, refs, emailRedirect };
}

const PROFILE_PROCESS_ATTEMPT = 5;

export async function activateTestAccount(
  client: Client,
  input: ActivationInput,
): Promise<ActivationResult> {
  const sourceId = requireSafeId("Source id", input.sourceId);
  const profileId = requireSafeId("Identity profile id", input.profileId);
  const activeStateId = requireSafeId("Lifecycle state id", input.activeStateId);
  const identityNowSourceId = requireSafeId("IdentityNow source id", input.identityNowSourceId);
  const pending = (
    phase: ActivationResult["phase"],
    detail: string,
    processed = input.processed,
  ): ActivationResult => ({
    done: false,
    phase,
    detail,
    identityId: null,
    alias: null,
    processed,
    lifecycleState: null,
    accountEnabled: null,
    roleAssigned: false,
    passwordSet: input.passwordSet === true,
    passwordError: input.passwordError ?? null,
    inviteSent: input.inviteSent === true,
    inviteError: input.inviteError ?? null,
  });

  const accounts = await list(
    client,
    filtered(
      "/accounts/v1",
      `sourceId eq ${quoted(sourceId)} and nativeIdentity eq ${quoted(input.userId)}`,
    ),
  );
  const account = accounts.find((candidate) => accountIsUser(candidate, input.userId));
  if (!account) {
    await assertCreateTask(client, input.taskId);
    return pending("account-pending", `Waiting for ${ADMINS_SOURCE_NAME} to show ${input.userId}.`);
  }

  const identityId = text(account.identityId);
  if (!identityId) {
    let processed = input.processed;
    if (!processed && input.attempt >= PROFILE_PROCESS_ATTEMPT) {
      await client.request(
        "POST",
        `/identity-profiles/v1/${encodeURIComponent(profileId)}/process-identities`,
      );
      processed = true;
    }
    return pending(
      "identity-pending",
      processed
        ? "Identity profile processing started. Waiting for the identity."
        : "Account created. Waiting for the identity.",
      processed,
    );
  }

  let processed = input.processed;
  if (!processed) {
    await client.request("POST", "/identities/v1/process", { identityIds: [identityId] });
    processed = true;
  }

  const identity = record(
    await client.request("GET", `/identities/v1/${encodeURIComponent(identityId)}`),
  );
  const alias = text(identity.alias) || text(identity.name) || null;
  let passwordSet = input.passwordSet === true;
  let passwordError = input.passwordError ?? null;
  if (input.password && alias && !passwordSet && !passwordError) {
    try {
      await setIdentityPassword(client, alias, input.password);
      passwordSet = true;
    } catch (error) {
      if (!(error instanceof SailPointApiError) || error.status !== 403) {
        throw error;
      }
      passwordError =
        "SailPoint refused to set the password with the admin credential. Use Actions, Reset Password on the identity and send it to an inbox you can open.";
    }
  }
  let lifecycleState = text(record(identity.lifecycleState).stateName) || null;
  if (lifecycleState !== ACTIVE_STATE) {
    await client.request(
      "POST",
      `/identities/v1/${encodeURIComponent(identityId)}/set-lifecycle-state`,
      { lifecycleStateId: activeStateId },
    );
    lifecycleState = ACTIVE_STATE;
  }

  const identityNowAccounts = await list(
    client,
    filtered(
      "/accounts/v1",
      `identityId eq ${quoted(identityId)} and sourceId eq ${quoted(identityNowSourceId)}`,
    ),
  );
  let accountEnabled: boolean | null = identityNowAccounts.length
    ? identityNowAccounts[0].disabled !== true
    : null;
  if (accountEnabled === false) {
    try {
      await client.request(
        "POST",
        `/identities-accounts/v1/${encodeURIComponent(identityId)}/enable`,
      );
      accountEnabled = true;
    } catch (error) {
      if (!(error instanceof SailPointApiError) || error.status !== 400) {
        throw error;
      }
    }
  }

  const assignments = await client
    .request("GET", `/identities/v1/${encodeURIComponent(identityId)}/role-assignments`)
    .catch(() => []);
  const roleAssigned = (Array.isArray(assignments) ? assignments : []).some(
    (assignment) => text(record(record(assignment).role).name) === ROLE_NAME,
  );

  const ready =
    roleAssigned && accountEnabled === true && lifecycleState === ACTIVE_STATE;
  let inviteSent = input.inviteSent === true;
  let inviteError = input.inviteError ?? null;
  const redirectEmail = input.redirectEmail?.trim() ?? "";
  const wantsInvite = Boolean(redirectEmail || input.sendInvite);
  if (ready && wantsInvite && !inviteSent && !inviteError) {
    try {
      await client.request("POST", "/beta/identities/invite", {
        ids: [identityId],
        uninvited: false,
      });
      inviteSent = true;
    } catch (error) {
      if (!(error instanceof SailPointApiError)) {
        throw error;
      }
      inviteError = `SailPoint did not send the invitation (${error.status}).`;
    }
  }

  const done =
    ready &&
    (!input.password || passwordSet || Boolean(passwordError)) &&
    (!wantsInvite || inviteSent || Boolean(inviteError));
  const invitationInbox = redirectEmail || input.inviteEmail?.trim() || "the requester";
  const detail = done
    ? inviteSent
      ? `Invitation sent to ${invitationInbox}. The username is ${input.userId}. The link expires in 7 days.`
      : inviteError
        ? `The identity is active and has the role. ${inviteError}`
        : passwordError
          ? `The identity is active and has the role. ${passwordError}`
          : `The identity is active and has the role. Sign in as ${alias ?? input.userId}.`
    : roleAssigned
      ? "Role assigned. Waiting for the IdentityNow account."
      : `Waiting for the ${ROLE_NAME} role to assign.`;
  return {
    done,
    phase: done ? "complete" : "activating",
    detail,
    identityId,
    alias,
    processed,
    lifecycleState,
    accountEnabled,
    roleAssigned,
    passwordSet,
    passwordError,
    inviteSent,
    inviteError,
  };
}
