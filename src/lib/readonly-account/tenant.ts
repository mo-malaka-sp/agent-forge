import { constants, publicEncrypt } from "node:crypto";

import { loadSafPocConfig } from "@/lib/saf-poc/config";
import {
  createSailPointClient,
  SailPointApiError,
  type SailPointSetupConfig,
} from "@/lib/saf-poc/sailpoint";

export const TESTDRIVE_SOURCE_NAME = "TestDriveUsers";
export const TESTDRIVE_TYPE = "TestDrive";
export const TESTDRIVE_STATUS = "active";
export const IDENTITYNOW_SOURCE_NAME = "IdentityNow";
export const ROLE_NAME = "ReadOnly-Admins";
export const PASSWORD_SCOPE = "sp:scopes:all";
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

type Client = ReturnType<typeof readonlyAccountClient>;
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

export type AccountSchema = {
  names: string[];
  identityAttribute: string;
  displayAttribute: string;
};

export type TenantRefs = {
  sourceId: string;
  profileId: string;
  activeStateId: string;
  identityNowSourceId: string;
  sourceName?: string;
  accountNameIsEmail?: boolean;
  schema?: AccountSchema | null;
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
  accountName?: string;
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
    requestWithScope: (
      scope: string,
      method: string,
      path: string,
      body?: unknown,
      contentType?: string,
      extraHeaders?: Record<string, string>,
      credentials?: { clientId: string; clientSecret: string },
    ) =>
      client.requestWithScope(scope, method, path, body, contentType, {
        ...EXPERIMENTAL_HEADER,
        ...extraHeaders,
      }, credentials),
    passwordCredentials: client.passwordCredentials,
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
  const attributes = record(account.attributes);
  return (
    text(account.nativeIdentity) === userId ||
    text(attributes.id) === userId ||
    text(attributes["e-mail"]) === userId
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
    throw new Error(`The ${TESTDRIVE_SOURCE_NAME} account task failed (${completion}). ${inputTaskDetail(status)}`);
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

async function findSourceByName(client: Client, name: string): Promise<JsonRecord | null> {
  const sources = await list(client, filtered("/sources/v1", `name eq ${quoted(name)}`));
  const source = sources.find((candidate) => text(candidate.name) === name);
  if (!source || !text(source.id)) {
    return null;
  }
  return source;
}

async function findSource(client: Client, name: string): Promise<JsonRecord> {
  const source = await findSourceByName(client, name);
  if (!source) {
    throw new Error(`Source "${name}" was not found in the tenant.`);
  }
  return source;
}

async function findProfile(client: Client, sourceId: string, sourceName: string): Promise<JsonRecord> {
  const profiles = await list(client, "/identity-profiles/v1");
  const profile = profiles.find(
    (candidate) => text(record(candidate.authoritativeSource).id) === sourceId,
  );
  if (!profile || !text(profile.id)) {
    throw new Error(
      `No identity profile uses "${sourceName}" as its authoritative source.`,
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
          operation: "EQUALS",
          key: { type: "ACCOUNT", property: "attribute.type", sourceId },
          stringValue: TESTDRIVE_TYPE,
        },
      ],
    },
  };
}

function hasTypeCriteria(membership: unknown, sourceId: string): boolean {
  const matches = (node: unknown): boolean => {
    const criteria = record(node);
    const key = record(criteria.key);
    if (
      text(criteria.operation) === "EQUALS" &&
      text(key.property) === "attribute.type" &&
      text(key.sourceId) === sourceId &&
      text(criteria.stringValue) === TESTDRIVE_TYPE
    ) {
      return true;
    }
    return Array.isArray(criteria.children) && criteria.children.some(matches);
  };
  return matches(record(membership).criteria);
}

function membershipWithType(membership: unknown, sourceId: string) {
  if (hasTypeCriteria(membership, sourceId)) {
    return membership;
  }
  const child = roleMembership(sourceId).criteria.children[0];
  const current = record(membership);
  const criteria = record(current.criteria);
  if (text(current.type) === "STANDARD" && text(criteria.operation) === "OR" && Array.isArray(criteria.children)) {
    return {
      ...current,
      criteria: { ...criteria, children: [...criteria.children, child] },
    };
  }
  return roleMembership(sourceId);
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
  const next = membershipWithType(role.membership, sourceId);
  if (JSON.stringify(role.membership ?? null) !== JSON.stringify(next)) {
    operations.push({ op: "replace", path: "/membership", value: next });
  }
  return operations;
}

async function patch(client: Client, path: string, operations: unknown[]) {
  return client.request("PATCH", path, operations, "application/json-patch+json");
}

async function readAccountSchema(client: Client, sourceId: string): Promise<AccountSchema> {
  const schemas = await list(client, `/sources/v1/${encodeURIComponent(sourceId)}/schemas`);
  const account =
    schemas.find((schema) => text(schema.name).toLowerCase() === "account") ?? schemas[0];
  if (!account) {
    throw new Error(`SailPoint did not return an account schema for ${TESTDRIVE_SOURCE_NAME}.`);
  }
  const attributes = Array.isArray(account.attributes) ? account.attributes : [];
  const names = attributes.map((attribute) => text(record(attribute).name)).filter(Boolean);
  if (!names.some((name) => name.toLowerCase() === "type")) {
    throw new Error(
      `The ${ROLE_NAME} role cannot be granted from ${TESTDRIVE_SOURCE_NAME}. The account schema has no type attribute.`,
    );
  }
  return {
    names,
    identityAttribute: text(account.identityAttribute) || "e-mail",
    displayAttribute: text(account.displayAttribute) || "e-mail",
  };
}

async function chooseAccountSource(client: Client): Promise<{
  source: JsonRecord;
  profile: JsonRecord;
  schema: AccountSchema;
}> {
  const source = await findSource(client, TESTDRIVE_SOURCE_NAME);
  const sourceId = text(source.id);
  return {
    source,
    profile: await findProfile(client, sourceId, TESTDRIVE_SOURCE_NAME),
    schema: await readAccountSchema(client, sourceId),
  };
}

export async function setupTenant(client: Client): Promise<SetupResult> {
  const steps: SetupStep[] = [];
  try {
    const chosen = await chooseAccountSource(client);
    const source = chosen.source;
    const sourceName = text(source.name);
    const sourceId = text(source.id);
    steps.push({ label: `${sourceName} source`, status: "found", detail: sourceId });

    const profile = chosen.profile;
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
        throw new Error(`"${sourceName}" has no owner to own the role.`);
      }
      const created = record(
        await client.request("POST", "/roles/v1", {
          name: ROLE_NAME,
          description: `Grants ${SAF_ADMIN_ENTITLEMENT} to ${TESTDRIVE_SOURCE_NAME} accounts whose type is ${TESTDRIVE_TYPE}.`,
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

export function accountPassword(suffix = ""): string {
  return `TestDrive${suffix || "9"}!`;
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
    password: accountPassword(suffix),
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

async function postIdentityPassword(
  client: Client,
  userName: string,
  password: string,
  credentials?: { clientId: string; clientSecret: string },
) {
  const info = record(
    await client.requestWithScope(
      PASSWORD_SCOPE,
      "POST",
      "/v2025/query-password-info",
      {
        userName,
        sourceName: IDENTITYNOW_SOURCE_NAME,
      },
      undefined,
      undefined,
      credentials,
    ),
  );
  const publicKey = text(info.publicKey);
  const publicKeyId = text(info.publicKeyId);
  const identityId = text(info.identityId);
  const accounts = Array.isArray(info.accounts) ? info.accounts : [];
  const accountId = text(record(accounts[0]).accountId) || userName;
  if (!publicKey || !publicKeyId || !identityId) {
    throw new Error("SailPoint did not return the password encryption key.");
  }
  await client.requestWithScope(
    PASSWORD_SCOPE,
    "POST",
    "/v2025/set-password",
    {
      identityId,
      publicKeyId,
      accountId,
      sourceId: text(info.sourceId) || undefined,
      encryptedPassword: encryptPassword(publicKey, password),
    },
    undefined,
    undefined,
    credentials,
  );
}

async function setIdentityPassword(client: Client, userName: string, password: string) {
  try {
    await postIdentityPassword(client, userName, password);
  } catch (error) {
    const alternate = client.passwordCredentials();
    const canRetry =
      alternate &&
      error instanceof SailPointApiError &&
      (error.status === 403 || error.message.includes("no valid identityId"));
    if (!canRetry) {
      throw error;
    }
    try {
      await postIdentityPassword(client, userName, password, alternate);
    } catch (second) {
      if (second instanceof SailPointApiError && second.status === 403) {
        throw new SailPointApiError(
          403,
          `SAF_CLIENT_ID was refused, then SAF_PASSWORD_CLIENT_ID was refused. ${second.message}`,
        );
      }
      throw second;
    }
  }
}

export const NAME_LISTS = { first: FIRST_NAMES, last: LAST_NAMES, digits: DIGITS };

async function isTaken(client: Client, sourceId: string, user: TestUser): Promise<boolean> {
  const names = user.email && user.email !== user.id ? [user.id, user.email] : [user.id];
  for (const name of names) {
    const accounts = await list(
      client,
      filtered(
        "/accounts/v1",
        `sourceId eq ${quoted(sourceId)} and nativeIdentity eq ${quoted(name)}`,
      ),
    );
    if (accounts.length > 0) {
      return true;
    }
  }
  const identities = await list(
    client,
    filtered(
      "/identities/v1",
      `alias eq ${quoted(user.id)} or email eq ${quoted(user.email)}`,
    ),
  );
  return identities.some(
    (identity) =>
      text(identity.alias).toLowerCase() === user.id.toLowerCase() ||
      identityUsesEmail(identity, user.email),
  );
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
  const chosen = await chooseAccountSource(client);
  const sourceId = text(chosen.source.id);
  const profileId = text(chosen.profile.id);
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
    sourceName: text(chosen.source.name),
    profileId,
    activeStateId: text(active.id),
    identityNowSourceId: await identityNowSourceId(client),
    accountNameIsEmail: true,
    schema: chosen.schema,
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

export function leadSePlusAddress(leadEmail: string, id: string): string {
  const trimmed = leadEmail.trim();
  const at = trimmed.lastIndexOf("@");
  const local = at > 0 ? trimmed.slice(0, at).split("+")[0] : "";
  const domain = at > 0 ? trimmed.slice(at + 1) : "";
  if (!local || !domain || domain.includes("@") || !/^[a-z0-9.]+$/i.test(id)) {
    throw new Error("The Lead SE email is not valid.");
  }
  return `${local}+${id}@${domain}`;
}

export async function pickUniqueLeadSeCustomer(
  client: Client,
  sourceId: string,
  leadEmail: string,
  random: () => number = Math.random,
): Promise<{ user: TestUser; attempts: number }> {
  let attempts = 0;
  for (const digits of [0, 2, 3]) {
    for (let index = 0; index < ATTEMPTS_PER_LENGTH; index += 1) {
      attempts += 1;
      const generated = generateTestUser(digits, random);
      const user: TestUser = {
        ...generated,
        email: leadSePlusAddress(leadEmail, generated.id),
      };
      if (!(await isTaken(client, sourceId, user))) {
        return { user, attempts };
      }
    }
  }
  throw new Error(
    `Could not find an unused test account name after ${attempts} attempts. Try again.`,
  );
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

function identityUsesEmail(identity: JsonRecord, email: string): boolean {
  const wanted = email.trim().toLowerCase();
  const attributes = record(identity.attributes);
  return [identity.email, identity.workEmail, attributes.email, attributes["e-mail"]].some(
    (value) => text(value).toLowerCase() === wanted,
  );
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
  const matches = identities.filter((identity) => identityUsesEmail(identity, email));
  if (matches.length > 0) {
    const name = text(matches[0]?.name) || text(matches[0]?.alias) || "an existing identity";
    throw new Error(`${email.trim()} is already used by ${name}.`);
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

function schemaKey(schema: AccountSchema, ...candidates: string[]): string | null {
  const names = new Map(schema.names.map((name) => [name.toLowerCase(), name]));
  for (const candidate of candidates) {
    const found = names.get(candidate.toLowerCase());
    if (found) {
      return found;
    }
  }
  return null;
}

export function accountAttributes(
  user: TestUser,
  location: string,
  refs: TenantRefs,
): Record<string, string> {
  if (!refs.schema) {
    throw new Error(`SailPoint did not return an account schema for ${TESTDRIVE_SOURCE_NAME}.`);
  }
  const attributes: Record<string, string> = { sourceId: refs.sourceId };
  const assign = (key: string | null, value: string) => {
    if (key && value) {
      attributes[key] = value;
    }
  };
  assign(schemaKey(refs.schema, refs.schema.identityAttribute, "e-mail"), user.email);
  assign(schemaKey(refs.schema, refs.schema.displayAttribute), user.email);
  assign(schemaKey(refs.schema, "givenName", "firstName", "firstname"), user.givenName);
  assign(schemaKey(refs.schema, "familyName", "lastName", "lastname"), user.familyName);
  assign(schemaKey(refs.schema, "e-mail", "email", "mail"), user.email);
  assign(schemaKey(refs.schema, "type"), TESTDRIVE_TYPE);
  assign(schemaKey(refs.schema, "status"), TESTDRIVE_STATUS);
  assign(schemaKey(refs.schema, "location"), location);
  return attributes;
}

export function accountLookupName(user: TestUser, refs: TenantRefs): string {
  return refs.accountNameIsEmail ? user.email : user.id;
}

export async function createRequestedAccount(
  client: Client,
  user: TestUser,
  location: string,
  refs: TenantRefs,
): Promise<CreateResult> {
  const response = record(
    await client.request("POST", "/accounts/v1", {
      attributes: accountAttributes(user, location, refs),
    }),
  );
  return { user, attempts: 1, taskId: text(response.id) || null, refs, emailRedirect: null };
}

export async function findAsanaDriveAccounts(client: Client): Promise<
  Array<{ taskGid: string; user: TestUser; refs: TenantRefs }>
> {
  const refs = await resolveRefs(client);
  const accounts = await list(client, filtered("/accounts/v1", `sourceId eq ${quoted(refs.sourceId)}`));
  const found: Array<{ taskGid: string; user: TestUser; refs: TenantRefs }> = [];
  for (const account of accounts) {
    const attributes = record(account.attributes);
    const taskGid = text(attributes.location).match(/asana:(\d{5,20})$/)?.[1] ?? "";
    const id = text(account.nativeIdentity) || text(attributes["e-mail"]) || text(attributes.id);
    if (!taskGid || !id) {
      continue;
    }
    found.push({
      taskGid,
      refs,
      user: {
        id,
        name: `${text(attributes.givenName)} ${text(attributes.familyName)}`.trim() || id,
        givenName: text(attributes.givenName),
        familyName: text(attributes.familyName),
        email: text(attributes["e-mail"]),
        password: "",
      },
    });
  }
  return found;
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

export async function openLeadSeAccount(
  client: Client,
  input: { leadEmail: string; location: string },
  random: () => number = Math.random,
): Promise<{ created: boolean; result: CreateResult }> {
  const refs = await resolveRefs(client);
  const existing = await findAccountByLocation(client, refs.sourceId, input.location);
  if (existing) {
    const attributes = record(existing.attributes);
    const id = text(existing.nativeIdentity) || text(attributes["e-mail"]) || text(attributes.id);
    const givenName = text(attributes.givenName);
    const familyName = text(attributes.familyName);
    return {
      created: false,
      result: {
        user: {
          id,
          name: `${givenName} ${familyName}`.trim() || id,
          givenName,
          familyName,
          email: text(attributes["e-mail"]) || leadSePlusAddress(input.leadEmail, id),
          password: "",
        },
        attempts: 0,
        taskId: null,
        refs,
        emailRedirect: null,
      },
    };
  }
  const { user, attempts } = await pickUniqueLeadSeCustomer(
    client,
    refs.sourceId,
    input.leadEmail,
    random,
  );
  const result = await createRequestedAccount(client, user, input.location, refs);
  return { created: true, result: { ...result, attempts } };
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
    const id = text(existing.nativeIdentity) || text(attributes["e-mail"]) || text(attributes.id);
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
      attributes: accountAttributes(user, CAMPAIGN_LOCATION, refs),
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

  const accountKey = input.accountName?.trim() || input.userId;
  const sourceLabel = input.sourceName?.trim() || TESTDRIVE_SOURCE_NAME;
  const accounts = await list(
    client,
    filtered(
      "/accounts/v1",
      `sourceId eq ${quoted(sourceId)} and nativeIdentity eq ${quoted(accountKey)}`,
    ),
  );
  const account = accounts.find((candidate) => accountIsUser(candidate, accountKey));
  if (!account) {
    await assertCreateTask(client, input.taskId);
    return pending("account-pending", `Waiting for ${sourceLabel} to show ${accountKey}.`);
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

  const identityNowAccount = record(identityNowAccounts[0]);
  const identityNowName =
    text(identityNowAccount.nativeIdentity) ||
    text(record(identityNowAccount.attributes).id) ||
    text(record(identityNowAccount.attributes).name) ||
    alias ||
    "";
  if (input.password && identityNowAccounts.length > 0 && identityNowName && !passwordSet && !passwordError) {
    try {
      await setIdentityPassword(client, identityNowName, input.password);
      passwordSet = true;
    } catch (error) {
      if (
        error instanceof SailPointApiError &&
        error.status === 400 &&
        error.message.includes("was not found")
      ) {
        return pending(
          "activating",
          `Waiting for IdentityNow to recognize ${identityNowName} before setting the password.`,
          processed,
        );
      }
      if (error instanceof SailPointApiError && error.status === 403) {
        passwordError = `SailPoint refused to set the password. ${error.message}`;
      } else if (
        error instanceof SailPointApiError &&
        error.message.includes("no valid identityId")
      ) {
        passwordError =
          "SailPoint refused to set the password because the SAF client token has no user.";
      } else {
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
  const invitation = `Invitation sent to ${invitationInbox}. The link expires in 7 days.`;
  const detail = done
    ? inviteSent
      ? passwordError
        ? `${invitation} ${passwordError}`
        : invitation
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
